/**
 * Reading a line from stdin, without hanging the process afterwards.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * Reading from stdin resumes the stream and leaves its handle REFERENCED in
 * the event loop. `rl.close()` releases the readline interface but not the
 * handle, and `process.stdin.pause()` stops the data flow but still does not
 * unreference it. Measured on Node 22 with a piped stdin:
 *
 *   after close() + pause() : active resources ["PipeWrap","PipeWrap","Timeout"]
 *                             -> process never exits
 *   after adding unref()    : exits immediately
 *
 * On a TTY this goes unnoticed, because the terminal tears itself down. It
 * only bites when stdin is a PIPE - which is exactly the case whenever the
 * UI drives a command. The symptom is horrible to debug because the command
 * SUCCEEDS first: `scenario login` captured and saved a session, printed
 * "SESSION SAVED", and then hung forever, so the UI showed it running
 * indefinitely and never re-enabled its buttons.
 *
 * Three call sites had the same pattern. They now all come through here.
 */

import * as readline from 'node:readline';

/**
 * Ask a question and resolve with the answer.
 *
 * Returns '' when stdin closes without an answer, so a caller that treats
 * anything-but-yes as no behaves safely if the pipe goes away.
 */
export function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let settled = false;
    const finish = (answer: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      release();
      resolve(answer);
    };

    // If the parent closes the pipe we must not wait forever.
    rl.once('close', () => finish(''));
    rl.question(prompt, (answer) => finish(answer));
  });
}

/** Wait for Enter. Any typed text is ignored. */
export async function waitForEnter(prompt: string): Promise<void> {
  await askLine(prompt);
}

/**
 * Let go of stdin so the process can exit.
 *
 * pause() stops the flow; unref() is the part that actually lets the event
 * loop drain. Both are cheap, and doing only one of them is the bug above.
 */
function release(): void {
  try {
    process.stdin.pause();
    process.stdin.unref();
  } catch {
    // Nothing useful to do if the stream is already gone.
  }
}
