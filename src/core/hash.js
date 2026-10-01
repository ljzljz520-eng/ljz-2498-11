// 确定性 64 位 FNV-1a：用于子树内容指纹（内容寻址），不依赖第三方库。
const MASK = 0xffffffffffffffffn
const PRIME = 0x100000001b3n
const BASIS = 0xcbf29ce484222325n

export function hashString(str) {
  let h = BASIS
  for (let i = 0; i < str.length; i += 1) {
    h ^= BigInt(str.charCodeAt(i))
    h = (h * PRIME) & MASK
  }
  return h.toString(16).padStart(16, '0')
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
}

export function canonicalJson(value) {
  return stable(value)
}

export function hashValue(value) {
  return hashString(stable(value))
}
