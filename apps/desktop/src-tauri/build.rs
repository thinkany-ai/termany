fn main() {
  println!("cargo:rerun-if-changed=resources/server/build-id");
  tauri_build::build()
}
