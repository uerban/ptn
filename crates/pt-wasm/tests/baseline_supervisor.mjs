import {fork} from "node:child_process";

const supervised = () => process.env.PT_BASELINE_SUPERVISED === "1" && typeof process.send === "function";

/** Flush observed inputs to the parent before trusted engine code can block. */
export async function publishInputs(bytes, missingInputs) {
  if (!supervised()) return;
  await new Promise((resolve, reject) => process.send(
    {kind: "ptn-baseline-inputs", bytes, missingInputs},
    error => error ? reject(error) : resolve(),
  ));
}

/** Preserve completed tuples before the next synchronous query can block. */
export async function publishTuple(tuple) {
  if (!supervised()) return;
  await new Promise((resolve, reject) => process.send(
    {kind: "ptn-baseline-tuple", tuple},
    error => error ? reject(error) : resolve(),
  ));
}

/** The parent alone finalizes the immutable run after the child has exited. */
export function publishReport(report) {
  if (!supervised()) return false;
  process.send({kind: "ptn-baseline-report", report}, error => {
    if (error) process.exitCode = 1;
  });
  return true;
}

/** Wall-clock limit covers the child process, including synchronous WASM.
 * Killing the supervisor itself or engine-created subprocesses is outside this
 * contract. Raw output and a final report (if any) are preserved separately. */
export function superviseBaseline(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = fork(script, args, {
      env: {...process.env, PT_BASELINE_SUPERVISED: "1"},
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let bytes = {}, missingInputs = [], report, processError, timedOut = false;
    const stdout = [], stderr = [], tuples = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("message", message => {
      if (message?.kind === "ptn-baseline-inputs") {
        bytes = message.bytes;
        missingInputs = message.missingInputs;
      } else if (message?.kind === "ptn-baseline-report") report = message.report;
      else if (message?.kind === "ptn-baseline-tuple") tuples.push(message.tuple);
    });
    child.on("error", error => { processError = error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM cannot interrupt a synchronous engine that ignores it.
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({bytes, missingInputs, report, tuples, processError, timedOut, exitCode, signal,
        stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});
    });
  });
}
