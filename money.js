// Decimal-safe money: amounts are BigInt integer "units" (NGN = kobo, 2dp; USDT = 6dp).
export const DP = { NGN: 2, USDT: 6 };

export function toUnits(str, cur) {
  const dp = DP[cur];
  if (dp === undefined) throw new Error('Unsupported currency ' + cur);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(str).trim());
  if (!m) throw new Error('Bad amount: ' + str);
  const frac = (m[2] || '').slice(0, dp).padEnd(dp, '0');
  return BigInt(m[1] + frac);
}

export function fromUnits(units, cur, trim = false) {
  const dp = DP[cur];
  const s = BigInt(units).toString().padStart(dp + 1, '0');
  const whole = s.slice(0, -dp);
  let frac = s.slice(-dp);
  if (trim) frac = frac.replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
