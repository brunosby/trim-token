'use strict';
/**
 * Texts injected into the model's context. Short on purpose: they go into every session.
 * They describe how this project works instead of giving orders: text added by a hook in the
 * form of a system order can be taken for prompt injection and shown to the user instead of used.
 */

const CONTRACT = [
  'How work is done in this project. Every tool result stays in context and is re-read on each later turn, so its size is paid again on every call.',
  '- Code is located before it is read: a search for file names or line numbers first, then a Read of about 40-120 lines around the hit. A whole file is read only when the decision needs all of it.',
  '- When a task needs many facts from a large file or log, a short script extracts them and prints only the result.',
  '- Shell output is filtered and capped (| head -50); long runs go to a file that is then searched.',
  '- Answers lead with the result and use as few words as it needs; what the diff or tool output already show, and the steps taken, are left out; uncertainty takes one sentence where it matters.',
].join('\n');

const SUBAGENT = 'The final message of this subagent goes back to the agent that started it and is billed to the context of that agent. ' +
  'What helps it most is data: the verdict, path:line references and the exact lines it needs (at most 8 per place), so it does not read the files again; how the search went is not needed.';

module.exports = { CONTRACT, SUBAGENT };
