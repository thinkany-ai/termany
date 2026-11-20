import assert from "node:assert/strict";
import { test } from "node:test";
import { directPathHint } from "./directPathHint";

test("no note, no hint", () => {
  assert.equal(directPathHint(null), null);
  assert.equal(directPathHint("the device has no LAN or tailnet address"), null);
});

test("classifies each failure shape", () => {
  assert.equal(directPathHint("192.168.1.8:7681 connect EHOSTUNREACH 192.168.1.8:7681"), "blocked");
  assert.equal(directPathHint("192.168.1.8:7681 timed out after 2000 ms"), "timeout");
  assert.equal(directPathHint("192.168.1.8:7681 connect ECONNREFUSED 192.168.1.8:7681"), "refused");
});

test("the most telling failure wins across addresses", () => {
  const note = [
    "10.0.0.4:7681 timed out after 2000 ms",
    "192.168.1.8:7681 connect EHOSTUNREACH 192.168.1.8:7681",
  ].join("\n");
  assert.equal(directPathHint(note), "blocked");
  assert.equal(directPathHint("a timed out after 2000 ms\nb connect ECONNREFUSED b"), "timeout");
});
