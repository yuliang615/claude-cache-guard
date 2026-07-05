import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import {
  parseDisableOptions,
  parseInstallOptions,
  parseSettingOptions,
  resolveInstallThresholds,
  resolveSettingThresholds
} from "../src/cli.js";

function fakeTtyPair() {
  const input = new PassThrough();
  input.isTTY = true;
  let outputText = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    }
  });
  output.isTTY = true;
  output.getText = () => outputText;
  return { input, output };
}

function scriptedAsk(answers, output) {
  let index = 0;
  return async (prompt) => {
    output.write(prompt);
    return answers[index++] ?? "";
  };
}

test("interactive install prompt uses default 90 on Enter", async () => {
  const { input, output } = fakeTtyPair();
  const value = await resolveInstallThresholds({
    options: parseInstallOptions([]),
    configState: { exists: false, legacy: false },
    input,
    output,
    ask: scriptedAsk([""], output)
  });
  assert.deepEqual(value, { fiveHourWarning: 90 });
  assert.match(output.getText(), /At what 5-hour usage percentage/);
  assert.doesNotMatch(output.getText(), /critical/);
});

test("interactive install prompt retries invalid value", async () => {
  const { input, output } = fakeTtyPair();
  const value = await resolveInstallThresholds({
    options: parseInstallOptions([]),
    configState: { exists: false, legacy: false },
    input,
    output,
    ask: scriptedAsk(["abc", "60"], output)
  });
  assert.deepEqual(value, { fiveHourWarning: 60 });
  assert.match(output.getText(), /Please enter a number from 1 to 99/);
});

test("install threshold flag validates range", () => {
  assert.equal(parseInstallOptions(["--reconfigure"]).reconfigure, true);
  assert.equal(parseInstallOptions(["--five-hour-warning", "65"]).fiveHourWarning, 65);
  assert.throws(() => parseInstallOptions(["--force"]), /Unknown install option/);
  assert.throws(() => parseInstallOptions(["--five-hour-critical", "95"]), /Unknown install option/);
  assert.throws(() => parseInstallOptions(["--five-hour-warning", "0"]), /1 to 99/);
  assert.throws(() => parseInstallOptions(["--five-hour-warning", "100"]), /1 to 99/);
  assert.throws(() => parseInstallOptions(["--five-hour-warning", "abc"]), /1 to 99/);
  // Integers only — the /ccgconfig menu already enforces "integer 1-99", and
  // the CLI flag is the same setting via a different door.
  assert.throws(() => parseInstallOptions(["--five-hour-warning", "70.5"]), /1 to 99/);
});

test("interactive setting prompt uses effective project threshold on Enter", async () => {
  const { input, output } = fakeTtyPair();
  const value = await resolveSettingThresholds({
    options: parseSettingOptions([]),
    defaultWarning: 70,
    input,
    output,
    ask: scriptedAsk([""], output)
  });
  assert.deepEqual(value, { fiveHourWarning: 70 });
  assert.match(output.getText(), /this project start preparing next_session\.md/);
});

test("interactive setting prompt retries invalid value", async () => {
  const { input, output } = fakeTtyPair();
  const value = await resolveSettingThresholds({
    options: parseSettingOptions([]),
    defaultWarning: 75,
    input,
    output,
    ask: scriptedAsk(["100", "65"], output)
  });
  assert.deepEqual(value, { fiveHourWarning: 65 });
  assert.match(output.getText(), /Please enter a number from 1 to 99/);
});

test("setting threshold flag validates range", () => {
  assert.equal(parseSettingOptions(["--five-hour-warning", "65"]).fiveHourWarning, 65);
  assert.throws(() => parseSettingOptions(["--five-hour-critical", "95"]), /Unknown setting option/);
  assert.throws(() => parseSettingOptions(["--five-hour-warning", "0"]), /1 to 99/);
  assert.throws(() => parseSettingOptions(["--five-hour-warning", "100"]), /1 to 99/);
  assert.throws(() => parseSettingOptions(["--five-hour-warning", "abc"]), /1 to 99/);
  assert.throws(() => parseSettingOptions(["--five-hour-warning", "70.5"]), /1 to 99/);
});

test("disable options require explicit handoff removal flag", () => {
  assert.deepEqual(parseDisableOptions([]), { removeHandoff: false });
  assert.deepEqual(parseDisableOptions(["--rmhandoff"]), { removeHandoff: true });
  assert.throws(() => parseDisableOptions(["--remove"]), /Unknown disable option/);
});

test("non-TTY install prompt uses default without waiting", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = false;
  output.isTTY = false;
  assert.deepEqual(await resolveInstallThresholds({
    options: parseInstallOptions([]),
    configState: { exists: false, legacy: false },
    input,
    output
  }), { fiveHourWarning: 90 });
});

test("existing global config skips prompt and flag application", async () => {
  const { input, output } = fakeTtyPair();
  assert.equal(await resolveInstallThresholds({
    options: parseInstallOptions(["--five-hour-warning", "60"]),
    configState: { exists: true, legacy: false },
    input,
    output
  }), undefined);
  assert.equal(output.getText(), "");
});

test("existing global config with reconfigure prompts again", async () => {
  const { input, output } = fakeTtyPair();
  assert.deepEqual(await resolveInstallThresholds({
    options: parseInstallOptions(["--reconfigure"]),
    configState: { exists: true, legacy: false },
    input,
    output,
    ask: scriptedAsk(["88"], output)
  }), { fiveHourWarning: 88 });
  assert.match(output.getText(), /start preparing next_session\.md/);
});

test("non-TTY setting without flag fails instead of waiting", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = false;
  output.isTTY = false;
  await assert.rejects(resolveSettingThresholds({
    options: parseSettingOptions([]),
    defaultWarning: 90,
    input,
    output
  }), /requires --five-hour-warning/);
});

test("setting threshold flag skips prompt", async () => {
  const { input, output } = fakeTtyPair();
  assert.deepEqual(await resolveSettingThresholds({
    options: parseSettingOptions(["--five-hour-warning", "60"]),
    defaultWarning: 90,
    input,
    output
  }), { fiveHourWarning: 60 });
  assert.equal(output.getText(), "");
});
