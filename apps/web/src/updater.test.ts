import assert from "node:assert/strict";
import test from "node:test";
import { countRunningTasks, isUnsupportedUpdatePlatformError } from "./updater";

test("counts only tasks that are still working", () => {
  assert.equal(
    countRunningTasks({
      activities: {
        first: { status: "working" },
        second: { status: "done" },
        third: { status: "error" },
        fourth: { status: "working" },
      },
    }),
    2,
  );
});

test("treats missing or malformed activity payloads as idle", () => {
  assert.equal(countRunningTasks(null), 0);
  assert.equal(countRunningTasks({}), 0);
  assert.equal(countRunningTasks({ activities: null }), 0);
  assert.equal(countRunningTasks({ activities: { bad: null } }), 0);
});

test("recognizes the updater plugin's missing-platform error", () => {
  assert.equal(
    isUnsupportedUpdatePlatformError(
      new Error(
        'None of the fallback platforms `["windows-x86_64-nsis", "windows-x86_64"]` were found in the response `platforms` object',
      ),
    ),
    true,
  );
  assert.equal(
    isUnsupportedUpdatePlatformError(
      "None of the fallback platforms were found in the response platforms object",
    ),
    true,
  );
  assert.equal(isUnsupportedUpdatePlatformError(new Error("network request failed")), false);
  assert.equal(isUnsupportedUpdatePlatformError(null), false);
});
