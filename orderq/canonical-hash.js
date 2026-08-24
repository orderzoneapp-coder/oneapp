(function canonicalHashModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ORDERQ_CANONICAL_HASH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function canonicalHashFactory() {
  'use strict';

  function normalizeText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
  }
  function normalizeNumber(value) {
    if (value === '' || value === null || value === undefined) throw new Error('ORDERQ_CANONICAL_NUMBER_REQUIRED');
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('ORDERQ_CANONICAL_NUMBER_INVALID');
    return Object.is(number, -0) ? 0 : number;
  }
  function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    const codePointCompare = (left, right) => {
      const a = Array.from(normalizeText(left), char => char.codePointAt(0));
      const b = Array.from(normalizeText(right), char => char.codePointAt(0));
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
      return a.length - b.length;
    };
    if (value && typeof value === 'object') return Object.keys(value).sort(codePointCompare).reduce((result, key) => {
      if (value[key] !== undefined) result[normalizeText(key)] = canonicalValue(value[key]);
      return result;
    }, {});
    if (typeof value === 'string') return normalizeText(value);
    if (typeof value === 'number') return normalizeNumber(value);
    return value;
  }
  function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
  function sha256Text(value) {
    const input = unescape(encodeURIComponent(String(value ?? '')));
    const words = [];
    const bitLength = input.length * 8;
    for (let index = 0; index < input.length; index += 1) words[index >> 2] = (words[index >> 2] || 0) | input.charCodeAt(index) << (24 - (index % 4) * 8);
    words[bitLength >> 5] = (words[bitLength >> 5] || 0) | 0x80 << (24 - bitLength % 32);
    words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;
    const rotr = (number, bits) => number >>> bits | number << (32 - bits);
    const primes = [];
    for (let candidate = 2; primes.length < 64; candidate += 1) if (primes.every(prime => candidate % prime)) primes.push(candidate);
    const constants = primes.map(prime => Math.floor((Math.pow(prime, 1 / 3) % 1) * 0x100000000));
    let hash = primes.slice(0, 8).map(prime => Math.floor((Math.sqrt(prime) % 1) * 0x100000000));
    for (let offset = 0; offset < words.length; offset += 16) {
      const schedule = Array.from({ length: 16 }, (_, index) => words[offset + index] || 0);
      const previous = hash.slice();
      for (let index = 16; index < 64; index += 1) {
        const a = schedule[index - 15] || 0;
        const b = schedule[index - 2] || 0;
        schedule[index] = (schedule[index - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ a >>> 3) + schedule[index - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ b >>> 10)) | 0;
      }
      for (let index = 0; index < 64; index += 1) {
        const temp1 = (hash[7] + (rotr(hash[4], 6) ^ rotr(hash[4], 11) ^ rotr(hash[4], 25)) + (hash[4] & hash[5] ^ ~hash[4] & hash[6]) + constants[index] + schedule[index]) | 0;
        const temp2 = ((rotr(hash[0], 2) ^ rotr(hash[0], 13) ^ rotr(hash[0], 22)) + (hash[0] & hash[1] ^ hash[0] & hash[2] ^ hash[1] & hash[2])) | 0;
        hash = [(temp1 + temp2) | 0, hash[0], hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
      }
      hash = hash.map((number, index) => (number + previous[index]) | 0);
    }
    return hash.map(number => (number >>> 0).toString(16).padStart(8, '0')).join('');
  }
  function canonicalSha256(value) { return sha256Text(canonicalJson(value)); }
  return Object.freeze({ canonicalJson, canonicalSha256, canonicalValue, normalizeNumber, normalizeText, sha256Text });
});
