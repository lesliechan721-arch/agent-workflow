/**
 * macOS ps stops at the NUL padding left by process.title. The kernel string
 * area still contains the startup marker. This confirms an exact random token,
 * not its origin in the environment rather than argv or Apple strings.
 * The caller must validate the same PID/start identity after this read.
 */
export const DARWIN_PROCESS_MARKER_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.bindFunction('sysctl', ['int', ['void *', 'unsigned int', 'void *', 'void *', 'void *', 'unsigned long']]);
ObjC.bindFunction('__error', ['int *', []]);
function run(argv) {
  var input = JSON.parse(argv[0]);
  var capacity = 1048576;
  function decode(value) { return $.NSData.alloc.initWithBase64EncodedStringOptions(value, 0); }
  function integer(data) {
    var bytes = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, 5));
    var value = 0;
    for (var i = bytes.length - 1; i >= 0; --i) value = value * 256 + bytes.charCodeAt(i);
    return value;
  }
  function mibData(pid) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var bytes = [1, 0, 0, 0, 49, 0, 0, 0, pid % 256, Math.floor(pid / 256) % 256,
      Math.floor(pid / 65536) % 256, Math.floor(pid / 16777216) % 256];
    var base64 = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var value = bytes[i] * 65536 + bytes[i + 1] * 256 + bytes[i + 2];
      base64 += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63]
        + alphabet[(value >>> 6) & 63] + alphabet[value & 63];
    }
    return decode(base64);
  }
  if (!Array.isArray(input.pids) || input.pids.length === 0 || input.pids.some(function(pid) {
    return typeof pid !== 'number' || pid < 1 || pid > 2147483647 || Math.floor(pid) !== pid;
  })) throw new Error('invalid-marker-request');
  var token = decode(input.token);
  var rows = [];
  var output = $.NSMutableData.dataWithLength(capacity);
  input.pids.forEach(function(pid) {
    // Fixed 64-bit size_t and capacity on both supported macOS architectures.
    var size = $.NSMutableData.dataWithData(decode('AAAQAAAAAAA='));
    var mib = mibData(pid);
    var result = $.sysctl(mib.bytes, 3, output.mutableBytes, size.mutableBytes, null, 0);
    if (result !== 0) {
      var errno = $.__error()[0];
      rows.push({ pid: pid, marker: null, errno: errno });
      return;
    }
    var length = integer(size);
    if (length < 8 || length > capacity) {
      rows.push({ pid: pid, marker: null, errno: 0 });
      return;
    }
    // Bound the search to returned bytes, excluding argc and unused capacity.
    var found = output.rangeOfDataOptionsRange(token, 0, $.NSMakeRange(4, length - 4));
    rows.push({ pid: pid, marker: found.location < length, errno: 0 });
  });
  return JSON.stringify(rows);
}
`;
