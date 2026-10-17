#!/usr/bin/env node
// tools/decode-desc.mjs — decode the embedded protobuf FileDescriptorProto(s)
// recovered from the Muse client JS, printing message/field/oneof layout.
import fs from 'node:fs'

function readVarint(buf, pos) {
  let out = 0n, shift = 0n, i = pos
  while (true) {
    const b = buf[i++]
    out |= BigInt(b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7n
  }
  return { val: out, next: i }
}
function parseFields(buf, start, end) {
  const out = []
  let i = start
  while (i < end) {
    const { val: key, next } = readVarint(buf, i); i = next
    const fn = Number(key >> 3n), wt = Number(key & 7n)
    let val
    if (wt === 0) { const r = readVarint(buf, i); val = r.val; i = r.next }
    else if (wt === 2) { const r = readVarint(buf, i); const len = Number(r.val); i = r.next; val = buf.subarray(i, i + len); i += len }
    else if (wt === 5) { val = buf.readUInt32LE(i); i += 4 }
    else if (wt === 1) { val = buf.readBigUInt64LE(i); i += 8 }
    else { val = `wt${wt}`; break }
    out.push({ fn, wt, val })
  }
  return out
}
const TYPE = { 1:'double',2:'float',3:'int64',4:'uint64',5:'int32',6:'fixed64',7:'fixed32',8:'bool',9:'string',10:'group',11:'message',12:'bytes',13:'uint32',14:'enum',15:'sfixed32',16:'sfixed64',17:'sint32',18:'sint64' }
const LABEL = { 1:'required',2:'optional',3:'repeated' }

function decodeMessage(buf) { return parseFields(buf, 0, buf.length) }
function str(buf) { return Buffer.from(buf).toString('utf8') }

function dumpFile(bytes, label) {
  console.log(`\n===== ${label} (${bytes.length} bytes) =====`)
  const top = decodeMessage(bytes)
  console.log('top-level fields:', top.map((f) => `f${f.fn}/wt${f.wt}${f.wt===2?'('+f.val.length+'b)':''}`).join(' '))
  let pkg = ''
  for (const f of top) { if (f.fn === 1 && f.wt === 2) console.log('file:', str(f.val)); if (f.fn === 2 && f.wt === 2) pkg = str(f.val) }
  console.log('package:', pkg)
  const messages = top.filter((f) => f.fn === 4 && f.wt === 2)
  const enums = top.filter((f) => f.fn === 5 && f.wt === 2)
  let mi = 0
  for (const m of messages) {
    const mf = decodeMessage(m.val)
    const name = str(mf.find((x) => x.fn === 1 && x.wt === 2)?.val || '')
    console.log(`\nmessage[${mi}] ${name} {`)
    const oneofs = mf.filter((x) => x.fn === 10 && x.wt === 2).map((x) => decodeMessage(x.val))
    for (const of of oneofs) { const on = str(of.find((x) => x.fn === 1 && x.wt === 2)?.val || ''); console.log(`  oneof ${on}`) }
    for (const fld of mf.filter((x) => x.fn === 2 && x.wt === 2)) {
      const ff = decodeMessage(fld.val)
      const fname = str(ff.find((x) => x.fn === 1 && x.wt === 2)?.val || '')
      const num = Number(ff.find((x) => x.fn === 3 && x.wt === 0)?.val || 0)
      const label = LABEL[Number(ff.find((x) => x.fn === 4 && x.wt === 0)?.val || 0)] || ''
      const type = Number(ff.find((x) => x.fn === 5 && x.wt === 0)?.val || 0)
      const tn = ff.find((x) => x.fn === 6 && x.wt === 2)?.val
      const oneofIdx = ff.find((x) => (x.fn === 9 || x.fn === 10) && x.wt === 0)?.val
      const t = TYPE[type] || `t${type}`
      const suffix = tn ? ` -> ${str(tn)}` : ''
      const oo = oneofIdx !== undefined ? ` [oneof#${oneofIdx}]` : ''
      console.log(`  ${label} ${t} ${fname} = ${num}${suffix}${oo}`)
    }
    console.log('}')
    mi++
  }
  for (const e of enums) {
    const ef = decodeMessage(e.val)
    const name = str(ef.find((x) => x.fn === 1 && x.wt === 2)?.val || '')
    const vals = ef.filter((x) => x.fn === 2 && x.wt === 2).map((v) => { const vf = decodeMessage(v.val); return `${str(vf.find((x)=>x.fn===1&&x.wt===2)?.val||'')}=${Number(vf.find((x)=>x.fn===2&&x.wt===0)?.val||0)}` })
    console.log(`\nenum ${name} { ${vals.join(', ')} }`)
  }
}

for (const [p, label] of [['/tmp/M.bin', 'noise_envelope.proto'], ['/tmp/_.bin', 'chunking.proto']]) {
  if (fs.existsSync(p)) dumpFile(fs.readFileSync(p), label)
}
