// Shared boundary data for the parent runtime, installed scripts, and MCP tools.
const prefix = '\ufeff 父输入\r\n😀 " \\ ` $()\nEND_MESSAGE:00000000\n';
export const messageBodies = [
  prefix + 'x'.repeat(24576 - Buffer.byteLength(prefix)),
  'x' + '\u0001'.repeat(24575),
];
