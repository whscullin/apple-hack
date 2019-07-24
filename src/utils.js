const toHex = (val, len) => {
  if (!len) {
    len = val < 256 ? 2 : 4
  }
  var result = ''
  for (var idx = 0; idx < len; idx++) {
    result = (val & 0x0f).toString(16) + result
    val >>= 4
  }
  return result
}

module.exports = {
  toHex
}
