import { createServer } from 'node:http2';
import { renameSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// Fixed Cursor CLI 2026.11.05-86047df AgentService.Run. This fixture asks for
// RequestContext over Connect and stops after capturing the Skill policy bits.
// It implements no model, tool execution, or remote forwarding.
const sizeLimit = 2 * 1024 * 1024;
const report = process.argv[2];
const manualBody = Buffer.from('AW-CURSOR-FIXTURE-MANUAL-BODY');

function readFields(bytes) {
  let cursor = 0;
  function readVarint() {
    let value = 0;
    let scale = 1;
    for (let index = 0; index < 10 && cursor < bytes.length; index++) {
      const digit = bytes[cursor++];
      value += (digit & 127) * scale;
      if (digit < 128) return value;
      scale *= 128;
    }
    throw new Error('invalid-cursor-protobuf-varint');
  }
  const fields = [];
  while (cursor < bytes.length) {
    const tag = readVarint();
    const id = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) fields.push({ id, data: readVarint() });
    else if (wireType === 2) {
      const length = readVarint();
      fields.push({ id, data: bytes.subarray(cursor, cursor + length) });
      cursor += length;
    } else if (wireType === 1) cursor += 8;
    else if (wireType === 5) cursor += 4;
    else throw new Error('invalid-cursor-protobuf-field');
    if (cursor > bytes.length) throw new Error('invalid-cursor-protobuf-length');
  }
  return fields;
}

const bytesField = (id, data) => Buffer.concat([Buffer.from([id * 8 + 2, data.length]), data]);
const requestContext = bytesField(2, Buffer.concat([
  Buffer.from([8, 1]), // ExecServerMessage.id
  bytesField(15, Buffer.from('fixture-skill-policy')), // exec_id
  bytesField(10, Buffer.alloc(0)), // request_context_args
]));

function frame(data, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function selectedFields(fields, id) {
  return fields.find(field => field.id === id)?.data;
}

function capturePolicy(response) {
  // ExecClientMessage.request_context_result -> success -> request_context.
  const result = selectedFields(readFields(response), 10);
  if (!result) return undefined;
  const success = selectedFields(readFields(result), 1);
  const context = readFields(selectedFields(readFields(success), 1));
  return context.filter(field => field.id === 29).map(({ data }) => {
    const skill = readFields(data);
    const path = selectedFields(skill, 1).toString();
    return { name: path.split('/').at(-2), source: selectedFields(skill, 7)?.toString().split(':')[0],
      disableModelInvocation: selectedFields(skill, 8) === 1 };
  }).filter(skill => ['aw-manual-qual', 'aw-ordinary-qual'].includes(skill.name)).sort((a, b) => a.name.localeCompare(b.name));
}

const server = createServer();
server.on('stream', (stream, headers) => {
  stream.on('error', () => {});
  if (headers[':path'] !== '/agent.v1.AgentService/Run' || headers['content-type'] !== 'application/connect+proto') {
    stream.respond({ ':status': 404 });
    stream.end();
    return;
  }
  stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
  let chunks = Buffer.alloc(0);
  let sent = false;
  let explicitBody = false;
  stream.on('data', chunk => {
    if (stream.writableEnded) return;
    chunks = Buffer.concat([chunks, chunk]);
    if (chunks.length > sizeLimit) { stream.close(); return; }
    try {
      while (chunks.length >= 5) {
        const length = chunks.readUInt32BE(1);
        if (chunks.length < length + 5) return;
        const flags = chunks[0];
        const data = chunks.subarray(5, length + 5);
        chunks = chunks.subarray(length + 5);
        if (flags !== 0 && flags !== 1) continue;
        for (const field of readFields(flags === 1 ? gunzipSync(data, { maxOutputLength: sizeLimit }) : data)) {
          if (field.id === 1 && !sent) {
            sent = true;
            explicitBody = field.data.includes(manualBody);
            stream.write(frame(requestContext));
          }
          if (field.id !== 2) continue; // AgentClientMessage.exec_client_message
          const evidence = capturePolicy(field.data);
          if (evidence === undefined) continue;
          writeFileSync(`${report}.tmp`, JSON.stringify({ policy: evidence, explicitBody }));
          renameSync(`${report}.tmp`, report);
          stream.end(frame(Buffer.from('{"error":{"code":"invalid_argument","message":"fixture captured skill policy"}}'), 2));
          return;
        }
      }
    } catch { stream.close(); }
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
