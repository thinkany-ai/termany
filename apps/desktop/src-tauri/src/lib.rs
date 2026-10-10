use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
mod macos_services {
    use std::cell::OnceCell;

    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApp, NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypeString,
    };
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
    use tauri::{AppHandle, Url};

    use super::emit_open_paths;

    #[derive(Debug, Default)]
    struct ServiceProviderIvars {
        app_handle: OnceCell<AppHandle>,
    }

    define_class!(
        // SAFETY: NSObject has no additional subclassing requirements here, and
        // this object is intentionally leaked for the app lifetime.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = ServiceProviderIvars]
        struct TermanyServiceProvider;

        unsafe impl NSObjectProtocol for TermanyServiceProvider {}

        impl TermanyServiceProvider {
            #[unsafe(method(openInTermany:userData:error:))]
            fn open_in_termany(
                &self,
                pasteboard: &NSPasteboard,
                _user_data: Option<&NSString>,
                _error: *mut *mut NSString,
            ) {
                let Some(app_handle) = self.ivars().app_handle.get() else {
                    return;
                };
                let paths = paths_from_pasteboard(pasteboard);
                emit_open_paths(app_handle, paths);
            }
        }
    );

    impl TermanyServiceProvider {
        fn new(app_handle: AppHandle, mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(ServiceProviderIvars::default());
            let this: Retained<Self> = unsafe { msg_send![super(this), init] };
            let _ = this.ivars().app_handle.set(app_handle);
            this
        }
    }

    fn paths_from_pasteboard(pasteboard: &NSPasteboard) -> Vec<String> {
        let mut paths = Vec::new();
        let Some(items) = pasteboard.pasteboardItems() else {
            return paths;
        };

        for i in 0..items.count() {
            let item: Retained<NSPasteboardItem> = items.objectAtIndex(i);
            if let Some(file_url) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
                if let Ok(url) = Url::parse(&file_url.to_string()) {
                    if let Ok(path) = url.to_file_path() {
                        paths.push(path.to_string_lossy().into_owned());
                        continue;
                    }
                }
            }
            // Finder matches this service through the plain-text (FilePath)
            // flavour, so the item can carry bare paths instead of file URLs.
            if let Some(text) = item.stringForType(unsafe { NSPasteboardTypeString }) {
                for line in text.to_string().lines() {
                    let line = line.trim();
                    if line.starts_with('/') {
                        paths.push(line.to_string());
                    }
                }
            }
        }

        paths
    }

    pub fn install(app_handle: AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let provider = TermanyServiceProvider::new(app_handle, mtm);
        let app = NSApp(mtm);
        unsafe { app.setServicesProvider(Some(provider.as_ref())) };
        let _: *const TermanyServiceProvider = Retained::into_raw(provider);
    }
}

/// Holds the bundled Node PTY/API server child so we can kill it on exit.
struct ServerProcess(Mutex<Option<Child>>);

/// Counts unexpected server exits (crash, lost the port race) so the restart
/// loop below can give up instead of spinning forever if the binary is broken.
struct ServerRestartAttempts(AtomicU32);
const MAX_AUTO_RESTARTS: u32 = 3;
const SERVER_PORT: u16 = 5174;

/// Set once the user confirms the quit-confirm dialog, so the `ExitRequested`
/// handler below can tell that apart from the original OS/menu request that
/// triggered it — `AppHandle::exit()` itself raises another `ExitRequested`,
/// and without this flag that second one gets intercepted just like the
/// first, so confirming Quit silently reopens the same dialog forever.
struct QuitState(AtomicBool);

#[tauri::command]
fn confirm_quit(app: tauri::AppHandle, quitting: tauri::State<'_, QuitState>) {
    quitting.0.store(true, Ordering::SeqCst);
    // Windows has no tray/background-mode UI. Closing the window must therefore
    // close both the Tauri process and its bundled Node server. This also cleans
    // up a same-version server reused from an earlier launch, which is not held
    // in ServerProcess and cannot be reached through kill_server alone.
    #[cfg(target_os = "windows")]
    {
        // Dev uses port 5175 and may intentionally run beside an installed
        // release on 5174; never let closing `tauri dev` kill that release.
        if !cfg!(debug_assertions) {
            kill_server(&app);
            kill_termany_server_on_port();
        }
    }
    app.exit(0);
}

struct OpenPathState(Mutex<OpenPathStateInner>);

struct OpenPathStateInner {
    pending: Vec<String>,
    frontend_ready: bool,
}

#[tauri::command]
fn frontend_ready_for_open_paths(state: tauri::State<'_, OpenPathState>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut guard) => {
            guard.frontend_ready = true;
            std::mem::take(&mut guard.pending)
        }
        Err(_) => Vec::new(),
    }
}

/// Minimal blocking HTTP GET against the local server; `None` unless it answered
/// 200. Hand-rolled because this runs before anything else is up and a real HTTP
/// client would be a dependency for one request.
fn server_get(path: &str) -> Option<String> {
    let mut addrs = ("127.0.0.1", SERVER_PORT).to_socket_addrs().ok()?;
    let addr = addrs.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    // `Connection: close` means the server ends the body by closing the socket,
    // so reading to EOF needs no Content-Length parsing.
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !(head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")) {
        return None; // includes the 404 an older server gives for /api/version
    }
    Some(body.to_owned())
}

/// Pull `version` out of `{"version":"0.1.17"}` without pulling in a JSON dep.
fn parse_version_field(body: &str) -> Option<String> {
    let rest = body.split_once("\"version\"")?.1;
    let rest = rest.split_once('"')?.1;
    let (value, _) = rest.split_once('"')?;
    Some(value.to_owned())
}

/// Count task records that are still actively working. The server owns this
/// ledger across every window, so it is the authoritative update/restart guard.
fn parse_running_task_count(body: &str) -> Option<usize> {
    let payload: serde_json::Value = serde_json::from_str(body).ok()?;
    let activities = payload.get("activities")?.as_object()?;
    Some(
        activities
            .values()
            .filter(|activity| activity.get("status").and_then(|v| v.as_str()) == Some("working"))
            .count(),
    )
}

fn running_server_task_count() -> usize {
    server_get("/api/activity")
        .as_deref()
        .and_then(parse_running_task_count)
        .unwrap_or(0)
}

/// Is a server already listening on our port, and is it OURS?
///
/// In a packaged build there is no `pnpm dev:web` to start the backend, so the
/// app launches the bundled Node server itself (PTY over ws://localhost:5174 +
/// the /api/* endpoints) — unless a usable one is already there.
///
/// "Responds at all" is not enough. The bundled server deliberately outlives an
/// ordinary quit (so shells survive relaunch), which means that right after an
/// upgrade the PREVIOUS release's server is usually still holding the port. If
/// we reuse it, this build's UI ends up talking to an older backend and every
/// route added since that release 404s — the user sees a dashboard stuck on
/// "Could not load …" with nothing obviously wrong. So a version mismatch
/// normally counts as unhealthy: the caller kills it and spawns the matching
/// one. The exception is a server that still owns a working task; preserving
/// that process takes priority, and the next safe relaunch completes the swap.
///
/// This applies in either direction, including the rarer downgrade/run-an-
/// older-build case — matching this app beats guessing once it is safe.
fn existing_server_matches(expected: &str) -> bool {
    let Some(body) = server_get("/api/version") else {
        return false;
    };
    match parse_version_field(&body) {
        Some(found) if found == expected => true,
        Some(found) => {
            let running = running_server_task_count();
            if running > 0 {
                log::warn!(
                    "[termany] server on localhost:{SERVER_PORT} is version {found}, this app is {expected}, but it owns {running} running task(s) — deferring the server upgrade"
                );
                return true;
            }
            log::warn!(
                "[termany] server on localhost:{SERVER_PORT} is version {found}, this app is {expected} — restarting it"
            );
            false
        }
        None => false,
    }
}

fn server_port_is_open() -> bool {
    let Ok(mut addrs) = ("127.0.0.1", SERVER_PORT).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

#[cfg(unix)]
fn listening_pids_on_server_port() -> Vec<String> {
    let Ok(output) = Command::new("lsof")
        .args(["-nP", "-a", "-iTCP:5174", "-sTCP:LISTEN", "-Fp"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('p'))
        .filter(|pid| pid.chars().all(|c| c.is_ascii_digit()))
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(unix)]
fn command_for_pid(pid: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", pid, "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(any(target_os = "windows", test))]
fn parse_pid_lines(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .filter(|pid| !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()))
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(target_os = "windows")]
fn hidden_windows_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(program);
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

#[cfg(target_os = "windows")]
fn listening_pids_on_server_port() -> Vec<String> {
    let script = format!(
        "Get-NetTCPConnection -State Listen -LocalPort {SERVER_PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"
    );
    let Ok(output) = hidden_windows_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_pid_lines(&output.stdout)
}

#[cfg(target_os = "windows")]
fn command_for_pid(pid: &str) -> Option<String> {
    if !pid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let script = format!(
        "(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' -ErrorAction SilentlyContinue).CommandLine"
    );
    let output = hidden_windows_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!command.is_empty()).then_some(command)
}

fn is_termany_server_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    command.contains("server.cjs")
        && (command.contains("/termany.app/")
            || command.contains("/termany/")
            || command.contains("\\termany\\"))
}

#[cfg(any(unix, target_os = "windows"))]
fn kill_termany_server_on_port() {
    if !server_port_is_open() {
        return;
    }

    for pid in listening_pids_on_server_port() {
        let Some(command) = command_for_pid(&pid) else {
            continue;
        };
        if !is_termany_server_command(&command) {
            log::warn!(
                "[termany] localhost:{SERVER_PORT} is occupied by a non-Termany process: {command}"
            );
            continue;
        }
        log::warn!("[termany] killing stale PTY server pid {pid}: {command}");
        #[cfg(unix)]
        let _ = Command::new("kill").arg(&pid).status();
        #[cfg(target_os = "windows")]
        match hidden_windows_command("taskkill.exe")
            .args(["/PID", &pid, "/T", "/F"])
            .status()
        {
            Ok(status) if status.success() => {}
            Ok(status) => {
                log::error!("[termany] taskkill failed for stale PTY server pid {pid}: {status}")
            }
            Err(error) => log::error!(
                "[termany] could not run taskkill for stale PTY server pid {pid}: {error}"
            ),
        }
    }

    for _ in 0..20 {
        if !server_port_is_open() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn kill_termany_server_on_port() {}

fn attach_server_log(app: &tauri::AppHandle, command: &mut Command) {
    let Ok(log_dir) = app.path().app_log_dir() else {
        log::warn!("[termany] could not resolve app log directory for bundled server");
        return;
    };
    if let Err(error) = std::fs::create_dir_all(&log_dir) {
        log::warn!("[termany] could not create app log directory {log_dir:?}: {error}");
        return;
    }
    let path = log_dir.join("server.log");
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        log::warn!("[termany] could not open bundled server log {path:?}");
        return;
    };
    // Keep diagnostics bounded while retaining multiple watchdog attempts from
    // the same failure. The next launch starts a fresh log once it exceeds 2 MB.
    if file
        .metadata()
        .is_ok_and(|metadata| metadata.len() > 2 * 1024 * 1024)
    {
        let _ = file.set_len(0);
    }
    let Ok(stdout) = file.try_clone() else {
        return;
    };
    command
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(file));
    log::info!("[termany] bundled server output: {path:?}");
}

/// Tauri returns extended-length paths such as `\\?\C:\...` for packaged
/// resources on Windows. Rust's process launcher accepts them, but Node 24's
/// entry-point resolver does not: it collapses the script argument to `C:` and
/// exits with `EISDIR: lstat 'C:'`. Convert the two Windows verbatim forms back
/// to regular DOS/UNC paths before handing them to Node.
#[cfg(any(target_os = "windows", test))]
fn node_compatible_windows_path(path: &std::path::Path) -> std::path::PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    path.to_owned()
}

fn spawn_server_child(app: &tauri::AppHandle) -> Option<Child> {
    let version = app.package_info().version.to_string();
    if existing_server_matches(&version) {
        log::info!("[termany] reusing existing PTY server on localhost:{SERVER_PORT}");
        return None;
    }
    kill_termany_server_on_port();

    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            log::error!("[termany] no resource dir: {e}");
            return None;
        }
    };
    #[cfg(target_os = "windows")]
    let resource_dir = node_compatible_windows_path(&resource_dir);
    // The bundled Node runtime is `node` on unix, `node.exe` on Windows.
    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
    // Tauri's resource glob (`resources/server/**/*`) preserves the leading
    // `resources/` segment, so the bundle lands at <Resources>/resources/server.
    // Fall back to <Resources>/server in case the mapping ever changes.
    let bundled = resource_dir.join("resources").join("server");
    let server_dir = if bundled.join(node_bin).exists() {
        bundled
    } else {
        resource_dir.join("server")
    };
    let node = server_dir.join(node_bin);
    let entry = server_dir.join("server.cjs");

    let mut command = Command::new(&node);
    command.arg(&entry).current_dir(&server_dir);
    attach_server_log(app, &mut command);
    // On Windows, spawning a console subprocess flashes a black cmd window;
    // CREATE_NO_WINDOW (0x0800_0000) keeps the bundled server headless.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    match command.spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            log::error!("[termany] failed to start server ({node:?}): {e}");
            None
        }
    }
}

/// Spawns the bundled server and stores it in the already-managed
/// `ServerProcess` state, then starts a watchdog thread that auto-restarts it
/// if it exits on its own (e.g. it lost the port race against a not-yet-dead
/// previous instance and gave up — see apps/server's own listen retry/backoff).
/// A deliberate stop (`kill_server`) empties the state *before* killing, so the
/// watchdog sees `None` and treats it as intentional rather than a crash.
fn start_server(app: &tauri::AppHandle) {
    let Some(child) = spawn_server_child(app) else {
        return;
    };
    if let Some(state) = app.try_state::<ServerProcess>() {
        *state.0.lock().unwrap() = Some(child);
    } else {
        app.manage(ServerProcess(Mutex::new(Some(child))));
    }

    let watched = app.clone();
    std::thread::spawn(move || monitor_server(watched));
}

fn monitor_server(app: tauri::AppHandle) {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Some(state) = app.try_state::<ServerProcess>() else {
            return;
        };
        let mut guard = state.0.lock().unwrap();
        match guard.as_mut() {
            None => return, // stopped intentionally elsewhere (kill_server)
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => *guard = None, // exited on its own — fall through to restart
                _ => continue,                // still running (or a transient wait() error)
            },
        }
        drop(guard);
        break;
    }

    let attempts = app
        .try_state::<ServerRestartAttempts>()
        .map(|s| s.0.fetch_add(1, Ordering::SeqCst) + 1)
        .unwrap_or(u32::MAX);
    if attempts > MAX_AUTO_RESTARTS {
        log::error!("[termany] bundled server exited unexpectedly {attempts} times — giving up on auto-restart");
        return;
    }
    log::warn!("[termany] bundled server exited unexpectedly — restarting (attempt {attempts}/{MAX_AUTO_RESTARTS})");
    start_server(&app);
}

fn kill_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServerProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Explicitly stop the bundled server. Ordinary window/app close leaves it
/// running (see `run` below) so terminal sessions survive quitting and
/// reopening the app — but a self-update swaps the server binary underneath
/// it, so the frontend calls this right before `relaunch()` to make sure the
/// next launch starts a server that matches the new build instead of talking
/// to a stale one. Return a non-zero count instead of stopping when another
/// window started a task after the frontend's first safety check. No-op in dev
/// (no bundled server, no managed state).
#[tauri::command]
fn stop_server(app: tauri::AppHandle) -> usize {
    let running = running_server_task_count();
    if running > 0 {
        log::info!("[termany] deferring update restart for {running} running task(s)");
        return running;
    }
    kill_server(&app);
    0
}

#[tauri::command]
fn webview_history(app: tauri::AppHandle, label: String, direction: String) -> Result<(), String> {
    if !label.starts_with("web_") {
        return Err("invalid webview label".into());
    }
    let script = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        _ => return Err("invalid history direction".into()),
    };
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "webview not found".to_string())?;
    webview.eval(script).map_err(|e| e.to_string())
}

/// The window the app was launched with. Extra windows get `main-2`, `main-3`,
/// … — see `create_window`. Both patterns are listed in the capability file, so
/// keep the prefix in sync with `capabilities/default.json` if it ever changes.
const MAIN_WINDOW_LABEL: &str = "main";

/// Suffix for the next extra window's label. Monotonic within a run so a label
/// is never reused while its old window is still tearing down; it restarts at 2
/// on the next launch, which is deliberate — the webview keys its per-window
/// view (workspace + page) by label, so a reopened `main-2` lands where it was.
struct WindowCounter(AtomicU32);

/// Which window is currently showing which page (`window label` → `page id`).
///
/// Windows share everything else — workspaces, pages, tabs and panes are one
/// record, and several windows in the same workspace is the point of having
/// them. Pages are the exception: a page owns live terminals, the PTY server
/// keeps exactly one socket per pane (it closes the previous on reattach), and
/// a browser pane is a native child webview that belongs to one window by
/// construction. So asking for a page another window holds raises that window
/// instead of opening it twice — see `claim_page`.
#[derive(Default)]
struct PageClaims(Mutex<HashMap<String, String>>);

/// The window an app-level action should land on: whichever one has focus,
/// falling back to the original window and then to any window at all. Every
/// place that used to hardcode `"main"` resolves through this — with several
/// windows open, "the app" means the one the user is looking at.
fn target_window(app_handle: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app_handle.webview_windows();
    windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.get(MAIN_WINDOW_LABEL))
        .or_else(|| windows.values().next())
        .cloned()
}

/// Emit to the focused window only. Events that drive a dialog (`quit-requested`)
/// or a one-shot action (`open-paths`) must not fan out to every window, or each
/// one would put up its own copy.
fn emit_to_target<P: serde::Serialize + Clone>(
    app_handle: &tauri::AppHandle,
    event: &str,
    payload: P,
) {
    if let Some(window) = target_window(app_handle) {
        let _ = app_handle.emit_to(window.label(), event, payload);
    }
}

/// Open another app window, cascaded off the focused one so it doesn't land
/// exactly on top. Chrome has to be set here rather than inherited: the window
/// in `tauri.conf.json` is a one-off declaration, not a template.
fn create_window(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let label = {
        let counter = app_handle.state::<WindowCounter>();
        loop {
            let n = counter.0.fetch_add(1, Ordering::SeqCst);
            let candidate = format!("{MAIN_WINDOW_LABEL}-{n}");
            if app_handle.get_webview_window(&candidate).is_none() {
                break candidate;
            }
        }
    };

    // Title, size and position come off the window in front where possible, so
    // the new one matches it — including the dev build, which calls itself
    // "Termany Dev" (tauri.dev.conf.json).
    let source = target_window(app_handle);
    let title = source
        .as_ref()
        .and_then(|window| window.title().ok())
        .unwrap_or_else(|| "Termany".to_string());

    let mut builder =
        tauri::WebviewWindowBuilder::new(app_handle, &label, tauri::WebviewUrl::default())
            .title(title)
            .inner_size(1280.0, 832.0)
            .min_inner_size(720.0, 480.0)
            .resizable(true)
            // Matches tauri.conf.json: the frontend draws its own titlebar,
            // traffic lights and rounded corners (see WindowControls.tsx).
            .decorations(false)
            .transparent(true)
            .shadow(true)
            // Start hidden. The window is transparent and undecorated, so until
            // the webview has painted there is literally nothing on screen —
            // showing it right away turns the startup wait into "New Window did
            // nothing", and the empty window steals the front spot meanwhile.
            // The frontend reveals it on its first frame (see revealWindow).
            .visible(false)
            .focused(true);
    // `dragDropEnabled: true` in tauri.conf.json is the builder's default —
    // it only exposes the opt-out (`disable_drag_drop_handler`), so leaving it
    // alone is what matches the declared window.

    if let Some(source) = source {
        if let Ok(scale) = source.scale_factor() {
            if let Ok(size) = source.inner_size() {
                let size = size.to_logical::<f64>(scale);
                builder = builder.inner_size(size.width, size.height);
            }
            if let Ok(position) = source.outer_position() {
                let position = position.to_logical::<f64>(scale);
                const CASCADE: f64 = 28.0;
                builder = builder.position(position.x + CASCADE, position.y + CASCADE);
            }
        }
    }

    let window = builder.build().map_err(|error| error.to_string())?;

    // Safety net for the hidden start above: if the frontend never gets as far
    // as revealing itself (a script error, or the server staying unreachable
    // for the whole startup timeout), show the window anyway rather than leave
    // an invisible one the user can neither see nor close.
    let fallback = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        if !fallback.is_visible().unwrap_or(true) {
            log::warn!("[termany] new window never reported ready — showing it anyway");
            let _ = fallback.show();
            let _ = fallback.set_focus();
        }
    });

    Ok(label)
}

#[tauri::command]
fn open_new_window(app: tauri::AppHandle) -> Result<String, String> {
    create_window(&app)
}

/// The pages spoken for by windows OTHER than `label`. Each window gets
/// its own answer — asking the webview which window it is would just be a
/// second, less reliable source of truth for something known for certain here.
fn claims_excluding(app_handle: &tauri::AppHandle, label: &str) -> Vec<String> {
    app_handle
        .state::<PageClaims>()
        .0
        .lock()
        .map(|claims| {
            claims
                .iter()
                .filter(|(other, _)| other.as_str() != label)
                .map(|(_, page)| page.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn broadcast_page_claims(app_handle: &tauri::AppHandle) {
    for label in app_handle.webview_windows().keys() {
        let claims = claims_excluding(app_handle, label);
        let _ = app_handle.emit_to(label.as_str(), "page-claims", claims);
    }
}

/// Pages another window is already showing, so this one can tell which are off
/// limits without a round trip per page.
#[tauri::command]
fn page_claims(app: tauri::AppHandle, window: tauri::Window) -> Vec<String> {
    claims_excluding(&app, window.label())
}

/// Record that `window` is showing `page_id`. Returns false when another
/// window already holds it — that window is raised instead, and the caller is
/// expected to stay where it is.
#[tauri::command]
fn claim_page(app: tauri::AppHandle, window: tauri::Window, page_id: String) -> bool {
    let label = window.label().to_string();
    let owner = {
        let state = app.state::<PageClaims>();
        let Ok(mut claims) = state.0.lock() else {
            return true; // a poisoned lock must not lock the user out of switching
        };
        let owner = claims
            .iter()
            .find(|(other, held)| *other != &label && *held == &page_id)
            .map(|(other, _)| other.clone());
        if owner.is_none() {
            claims.insert(label, page_id);
        }
        owner
    };

    match owner {
        // Raising happens outside the lock — set_focus can pump the event loop.
        Some(owner) => {
            if let Some(window) = app.get_webview_window(&owner) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            false
        }
        None => {
            broadcast_page_claims(&app);
            true
        }
    }
}

fn release_page_claim(app_handle: &tauri::AppHandle, label: &str) {
    let removed = app_handle
        .state::<PageClaims>()
        .0
        .lock()
        .map(|mut claims| claims.remove(label).is_some())
        .unwrap_or(false);
    if removed {
        broadcast_page_claims(app_handle);
    }
}

fn focus_app_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = target_window(app_handle) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Quake-style summon: hide when the app has focus, otherwise bring it up.
/// The focus check (not just visibility) matters — when the window is merely
/// behind another app, the hotkey should raise it, not hide it. With several
/// windows open the hotkey acts on all of them, so the app comes back exactly
/// as the user left it rather than one window at a time.
fn toggle_app_windows(app_handle: &tauri::AppHandle) {
    let windows = app_handle.webview_windows();
    if windows.is_empty() {
        return;
    }
    let showing = windows.values().any(|window| {
        window.is_focused().unwrap_or(false)
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false)
    });
    if showing {
        // Hide the whole app on macOS, not just the windows: focus then falls
        // back to the previously active app, so the user can keep typing where
        // they were — the iTerm2 hotkey-window behaviour.
        #[cfg(target_os = "macos")]
        let _ = app_handle.hide();
        #[cfg(not(target_os = "macos"))]
        for window in windows.values() {
            let _ = window.hide();
        }
    } else {
        #[cfg(target_os = "macos")]
        let _ = app_handle.show();
        for window in windows.values() {
            let _ = window.unminimize();
            let _ = window.show();
        }
        focus_app_window(app_handle);
    }
}

/// The currently registered summon shortcut ("alt+Backquote"-style plugin
/// syntax), if any. Kept in sync with the config file by the command below.
#[cfg(desktop)]
struct ToggleShortcutState(Mutex<Option<String>>);

#[cfg(desktop)]
fn toggle_shortcut_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window-toggle-shortcut.json"))
}

#[cfg(desktop)]
fn load_toggle_shortcut(app: &tauri::AppHandle) -> Option<String> {
    let raw = std::fs::read_to_string(toggle_shortcut_file(app)?).ok()?;
    serde_json::from_str::<Option<String>>(&raw).ok().flatten()
}

#[cfg(desktop)]
fn save_toggle_shortcut(app: &tauri::AppHandle, shortcut: &Option<String>) {
    let Some(path) = toggle_shortcut_file(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(json) = serde_json::to_string(shortcut) else {
        return;
    };
    if let Err(error) = std::fs::write(&path, json) {
        log::warn!("[termany] could not persist window toggle shortcut: {error}");
    }
}

/// (Un)register the OS-wide summon hotkey; `None` disables it. Failures (bad
/// syntax, or the chord is already claimed as another app's global hotkey)
/// come back as a String so the settings UI can show them — an unregistrable
/// shortcut must never fail silently.
#[cfg(desktop)]
fn apply_toggle_shortcut(app: &tauri::AppHandle, shortcut: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let state = app.state::<ToggleShortcutState>();
    let previous = state
        .0
        .lock()
        .map_err(|_| "shortcut state poisoned".to_string())?
        .take();
    if let Some(previous) = previous {
        if let Ok(parsed) = previous.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(parsed);
        }
    }
    let Some(next) = shortcut else {
        return Ok(());
    };
    let parsed: Shortcut = next.parse().map_err(|e| format!("{next}: {e}"))?;
    app.global_shortcut()
        .on_shortcut(parsed, |app_handle, _shortcut, event| {
            // The plugin reports press and release separately; only act on
            // press, or every tap would toggle twice.
            if event.state == ShortcutState::Pressed {
                toggle_app_windows(app_handle);
            }
        })
        .map_err(|e| e.to_string())?;
    *state
        .0
        .lock()
        .map_err(|_| "shortcut state poisoned".to_string())? = Some(next);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn get_window_toggle_shortcut(state: tauri::State<'_, ToggleShortcutState>) -> Option<String> {
    state.0.lock().ok().and_then(|guard| guard.clone())
}

#[cfg(not(desktop))]
#[tauri::command]
fn get_window_toggle_shortcut() -> Option<String> {
    None
}

#[cfg(desktop)]
#[tauri::command]
fn set_window_toggle_shortcut(
    app: tauri::AppHandle,
    shortcut: Option<String>,
) -> Result<(), String> {
    apply_toggle_shortcut(&app, shortcut.clone())?;
    save_toggle_shortcut(&app, &shortcut);
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_window_toggle_shortcut(_shortcut: Option<String>) -> Result<(), String> {
    Err("window toggle shortcut is desktop-only".into())
}

#[cfg(target_os = "windows")]
fn install_windows_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let menu = MenuBuilder::new(app)
        .text("tray_open", "Open Termany")
        .separator()
        .text("tray_quit", "Quit Termany")
        .build()?;

    let mut tray = TrayIconBuilder::with_id("termany")
        .menu(&menu)
        .tooltip("Termany")
        // A normal left click restores the app; the context menu stays on the
        // conventional right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "tray_open" => focus_app_window(app_handle),
            "tray_quit" => {
                focus_app_window(app_handle);
                emit_to_target(app_handle, "quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_app_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Explorer keys its shortcut icon cache primarily by the stable executable
/// path, so an in-place updater can leave a desktop shortcut showing an icon
/// embedded by an older Termany release. Notify the shell once per app version
/// after the new executable is running. The marker avoids doing a system-wide
/// association refresh on every launch.
#[cfg(target_os = "windows")]
fn refresh_windows_shortcut_icon_once(app: &tauri::App) {
    use std::ptr;
    use windows_sys::Win32::UI::Shell::{
        SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_FLUSH, SHCNF_IDLIST,
    };

    let Ok(data_dir) = app.path().app_local_data_dir() else {
        return;
    };
    let marker = data_dir.join(format!(
        ".shortcut-icon-refreshed-{}",
        app.package_info().version
    ));
    if marker.exists() {
        return;
    }
    if std::fs::create_dir_all(&data_dir).is_err() {
        return;
    }

    // SAFETY: SHCNE_ASSOCCHANGED with SHCNF_IDLIST requires both item pointers
    // to be null and does not retain them after this synchronous call.
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST | SHCNF_FLUSH,
            ptr::null(),
            ptr::null(),
        );
    }
    if let Err(error) = std::fs::write(&marker, b"") {
        log::warn!("[termany] could not persist shortcut icon refresh marker {marker:?}: {error}");
    }
}

fn emit_open_paths(app_handle: &tauri::AppHandle, paths: Vec<String>) {
    focus_app_window(app_handle);
    if paths.is_empty() {
        return;
    }

    let mut frontend_ready = true;
    if let Some(state) = app_handle.try_state::<OpenPathState>() {
        if let Ok(mut guard) = state.0.lock() {
            frontend_ready = guard.frontend_ready;
            if !guard.frontend_ready {
                guard.pending.extend(paths.iter().cloned());
            }
        }
    }

    if frontend_ready {
        emit_to_target(app_handle, "open-paths", paths);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Must be the first plugin registered: a second launch attempt (double
    // Dock click, "reopen windows" after a reboot, etc.) is redirected here
    // instead of spawning a second app + a second bundled server that would
    // just fight the first one for port 5174.
    //
    // Debug builds share the same bundle identifier (tauri.conf.json) as the
    // installed release app, and this plugin locks by identifier alone — with
    // it active in dev, `tauri dev` would detect the already-running installed
    // Termany.app as "another instance" and exit immediately instead of
    // opening a dev window. Only guard release builds, where this is needed.
    #[cfg(desktop)]
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths: Vec<String> = argv
                .into_iter()
                .skip(1)
                .filter(|a| std::path::Path::new(a).exists())
                .collect();
            emit_open_paths(app, paths);
        }));
    }
    builder = builder
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // Native OS notifications for agent turns that finish while the app is
        // in the background (see apps/web/src/agentNotifications.ts).
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            stop_server,
            frontend_ready_for_open_paths,
            webview_history,
            confirm_quit,
            get_window_toggle_shortcut,
            set_window_toggle_shortcut,
            open_new_window,
            claim_page,
            page_claims
        ])
        // Intercept the last window's close request before the webview is
        // destroyed. Waiting until RunEvent::ExitRequested is too late on
        // Windows: the event loop can be kept alive after the only window
        // (and the listener that shows the confirmation dialog) is gone.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app_handle = window.app_handle();
                // Extra windows are ordinary: closing one leaves the app (and
                // every shell in the other windows) running, so it needs no
                // confirmation. Only closing the last one means "quit", which
                // is the decision the dialog guards against doing by accident.
                if app_handle.webview_windows().len() > 1 {
                    return;
                }
                let Some(quitting) = app_handle.try_state::<QuitState>() else {
                    return;
                };
                if !quitting.0.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = app_handle.emit_to(window.label(), "quit-requested", ());
                }
            }
            // Frees the window's page for another window to open. Uses
            // Destroyed rather than CloseRequested so a close the dialog vetoes
            // doesn't hand the page away while it's still on screen.
            tauri::WindowEvent::Destroyed => {
                release_page_claim(window.app_handle(), window.label());
            }
            _ => {}
        });
    // Self-update: version check + install (desktop only; mobile stores handle it).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }
    builder
        .setup(|app| {
            app.manage(OpenPathState(Mutex::new(OpenPathStateInner {
                pending: Vec::new(),
                frontend_ready: false,
            })));
            app.manage(QuitState(AtomicBool::new(false)));
            app.manage(WindowCounter(AtomicU32::new(2)));
            app.manage(PageClaims::default());
            #[cfg(target_os = "macos")]
            macos_services::install(app.handle().clone());
            #[cfg(target_os = "windows")]
            {
                install_windows_tray(app)?;
                refresh_windows_shortcut_icon_once(app);
            }

            // Tauri auto-creates a default macOS menu bar when none is set,
            // and three of its predefined items actively fight this app:
            //   - "Quit" calls exit() directly, bypassing RunEvent::ExitRequested
            //     entirely (tauri-apps/tauri#3124), so the quit-confirm dialog
            //     wired up below never gets a chance to run.
            //   - "Close Window" binds ⌘W at the OS menu layer, intercepting the
            //     keystroke before it ever reaches the webview — silently eating
            //     the app's own ⌘W "close pane" shortcut.
            //   - "Minimize" binds ⌘M the same way, eating the app's own ⌘M
            //     "maximize/restore pane" shortcut.
            // Replacing it with our own menu fixes all three: a custom Quit item
            // routes through the same "quit-requested" event as Dock → Quit,
            // Window has no Close item so ⌘W falls through as a normal keydown,
            // and Minimize is rebuilt without a keyEquivalent (still works from
            // the menu, click-only) so ⌘M falls through the same way.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

                let quit = MenuItemBuilder::new("Quit Termany")
                    .id("quit")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Termany")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                // No accelerator on either item, for the ⌘M reason above: the
                // app binds New Window itself (Settings → Keyboard, ⌥⌘N by
                // default) so it stays rebindable and shows up in the ⌘P
                // palette. A menu keyEquivalent would swallow the keystroke
                // before the webview saw it, leaving two bindings to disagree.
                let new_window = MenuItemBuilder::new("New Window")
                    .id("new_window")
                    .build(app)?;
                let minimize = MenuItemBuilder::new("Minimize").id("minimize").build(app)?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .item(&new_window)
                    .separator()
                    .item(&minimize)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app_handle, event| match event.id().as_ref() {
                    "quit" => emit_to_target(app_handle, "quit-requested", ()),
                    "new_window" => {
                        if let Err(error) = create_window(app_handle) {
                            log::warn!("[termany] could not open a new window: {error}");
                        }
                    }
                    "minimize" => {
                        if let Some(window) = target_window(app_handle) {
                            let _ = window.minimize();
                        }
                    }
                    _ => {}
                });
            }

            #[cfg(desktop)]
            {
                app.manage(ToggleShortcutState(Mutex::new(None)));
                if let Some(saved) = load_toggle_shortcut(app.handle()) {
                    // Failure here (e.g. another app grabbed the chord since
                    // last run) must not block launch; the settings row lets
                    // the user re-register and see the error.
                    if let Err(error) = apply_toggle_shortcut(app.handle(), Some(saved.clone())) {
                        log::warn!(
                            "[termany] could not register window toggle shortcut {saved}: {error}"
                        );
                    }
                }
            }

            if !cfg!(debug_assertions) {
                app.manage(ServerRestartAttempts(AtomicU32::new(0)));
                start_server(app.handle());
            }

            Ok(())
        })
        // macOS keeps the bundled server alive across an ordinary quit so live
        // shells can resume. Windows' confirmed quit path stops the server and
        // exits completely; its tray icon is an open/quit affordance, not a
        // hidden background mode.
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // Always intercept the OS quit request (⌘Q, Dock → Quit, closing
                // the last window) and hand the decision to the frontend instead
                // of exiting immediately — guards against an accidental ⌘Q. The
                // frontend calls `confirm_quit` once the user confirms, which
                // sets `QuitState` before calling `AppHandle::exit()` — that
                // itself raises another `ExitRequested`, so this check is what
                // lets that second one through instead of re-prompting forever.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let quitting = app_handle.state::<QuitState>();
                    if !quitting.0.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        emit_to_target(app_handle, "quit-requested", ());
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let paths = urls
                        .into_iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .map(|path| path.to_string_lossy().into_owned())
                        .collect::<Vec<_>>();
                    emit_open_paths(app_handle, paths);
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        is_termany_server_command, node_compatible_windows_path, parse_pid_lines,
        parse_running_task_count, parse_version_field,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn reads_the_version_out_of_a_json_body() {
        assert_eq!(
            parse_version_field(r#"{"version":"0.1.17"}"#).as_deref(),
            Some("0.1.17")
        );
        // Whitespace and extra keys are what a different serializer might emit.
        assert_eq!(
            parse_version_field(r#"{"ok":true, "version": "1.2.3" }"#).as_deref(),
            Some("1.2.3")
        );
    }

    #[test]
    fn rejects_bodies_without_a_version() {
        // An older server 404s, so we only ever see a non-version body by accident.
        assert_eq!(parse_version_field("{}"), None);
        assert_eq!(parse_version_field("not json at all"), None);
        assert_eq!(parse_version_field(r#"{"version":"#), None);
    }

    #[test]
    fn counts_only_working_server_tasks() {
        assert_eq!(
            parse_running_task_count(
                r#"{"activities":{"a":{"status":"working"},"b":{"status":"done"},"c":{"status":"error"},"d":{"status":"working"}}}"#
            ),
            Some(2)
        );
        assert_eq!(parse_running_task_count(r#"{"activities":{}}"#), Some(0));
        assert_eq!(parse_running_task_count("not json"), None);
    }

    #[test]
    fn parses_only_numeric_listener_pids() {
        assert_eq!(
            parse_pid_lines(b"1234\r\n 5678 \r\nName\r\n\r\n"),
            vec!["1234", "5678"]
        );
    }

    /// The settings UI builds shortcut strings in windowToggle.ts
    /// (chordToGlobalShortcut): lowercase modifier names joined with "+",
    /// then a W3C KeyboardEvent.code. This pins the cross-language contract
    /// with the global-shortcut plugin's parser.
    #[cfg(desktop)]
    #[test]
    fn parses_the_frontend_shortcut_syntax() {
        use tauri_plugin_global_shortcut::Shortcut;
        for s in [
            "alt+Backquote",                 // macOS suggestion
            "super+Backquote",               // Windows suggestion
            "control+alt+Backquote",         // Linux suggestion
            "control+alt+shift+super+Space", // every modifier at once
            "F5",                            // bare key, no modifier
            "shift+Digit5",
            "control+KeyT",
        ] {
            assert!(s.parse::<Shortcut>().is_ok(), "should parse: {s}");
        }
    }

    #[test]
    fn identifies_only_bundled_termany_server_commands() {
        assert!(is_termany_server_command(
            r#"\"C:\\Users\\me\\AppData\\Local\\Termany\\resources\\server\\node.exe\" server.cjs"#
        ));
        assert!(is_termany_server_command(
            "/Applications/Termany.app/Contents/Resources/server/node server.cjs"
        ));
        assert!(!is_termany_server_command("node unrelated-server.cjs"));
        assert!(!is_termany_server_command("node server.cjs"));
    }

    #[test]
    fn removes_windows_verbatim_prefixes_before_launching_node() {
        assert_eq!(
            node_compatible_windows_path(Path::new(
                r"\\?\C:\Users\mike\AppData\Local\Termany\resources\server"
            )),
            PathBuf::from(r"C:\Users\mike\AppData\Local\Termany\resources\server")
        );
        assert_eq!(
            node_compatible_windows_path(Path::new(r"\\?\UNC\server\share\Termany")),
            PathBuf::from(r"\\server\share\Termany")
        );
        assert_eq!(
            node_compatible_windows_path(Path::new(r"C:\Termany\resources\server")),
            PathBuf::from(r"C:\Termany\resources\server")
        );
    }
}
