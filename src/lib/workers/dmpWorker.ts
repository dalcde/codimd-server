// external modules
// eslint-disable-next-line @typescript-eslint/camelcase
import { DIFF_DELETE, DIFF_INSERT, diff_match_patch, patch_obj } from 'diff-match-patch'
import { Revision } from '../models'

// Function for suppressing TS2722
// eslint-disable-next-line @typescript-eslint/unbound-method,@typescript-eslint/no-empty-function
function processSend (options): boolean {
  if (process?.send !== undefined) {
    return process.send(options)
  }
  return false
}

// We can't use the logger directly, because we are in a distinct nodejs
// process and the global instance of logger is not the one of the parent. In
// particular, it does not have the log level set correctly.
function log (level: string, msg, ...splat): boolean {
  return processSend({
    msg: 'log',
    level: level,
    result: [msg, splat],
    cacheKey: 1 // dummy value
  })
}
// eslint-disable-next-line @typescript-eslint/camelcase,new-cap
const dmp: diff_match_patch = new diff_match_patch()

// eslint-disable-next-line @typescript-eslint/camelcase
function getRevision (revisions: Revision[], count: number): { content: string; patch: patch_obj[]; authorship: string } {
  const msStart = (new Date()).getTime()
  let startContent = ''
  let lastPatch = ''
  // eslint-disable-next-line @typescript-eslint/camelcase
  let applyPatches: patch_obj[] = []
  let authorship = ''
  if (count <= Math.round(revisions.length / 2)) {
    // start from top to target
    for (let i = 0; i < count; i++) {
      const revision = revisions[i]
      if (i === 0) {
        startContent = revision.content || revision.lastContent
      }
      if (i !== count - 1) {
        // eslint-disable-next-line @typescript-eslint/camelcase
        const patch: patch_obj[] = dmp.patch_fromText(revision.patch)
        applyPatches = applyPatches.concat(patch)
      }
      lastPatch = revision.patch
      authorship = revision.authorship
    }
    // swap DIFF_INSERT and DIFF_DELETE to achieve unpatching
    for (let i = 0, l = applyPatches.length; i < l; i++) {
      for (let j = 0, m = applyPatches[i].diffs.length; j < m; j++) {
        const diff = applyPatches[i].diffs[j]
        if (diff[0] === DIFF_INSERT) {
          diff[0] = DIFF_DELETE
        } else if (diff[0] === DIFF_DELETE) {
          diff[0] = DIFF_INSERT
        }
      }
    }
  } else {
    // start from bottom to target
    const l = revisions.length - 1
    for (let i = l; i >= count - 1; i--) {
      const revision = revisions[i]
      if (i === l) {
        startContent = revision.lastContent
        authorship = revision.authorship
      }
      if (revision.patch) {
        // eslint-disable-next-line @typescript-eslint/camelcase
        const patch: patch_obj[] = dmp.patch_fromText(revision.patch)
        applyPatches = applyPatches.concat(patch)
      }
      lastPatch = revision.patch
      authorship = revision.authorship
    }
  }
  let finalContent = ''
  try {
    finalContent = dmp.patch_apply(applyPatches, startContent)[0]
  } catch (err) {
    throw new Error(err)
  }
  const data = {
    content: finalContent,
    patch: dmp.patch_fromText(lastPatch),
    authorship: authorship
  }
  const msEnd = (new Date()).getTime()
  log('debug', (msEnd - msStart) + 'ms')
  return data
}

function createPatch (lastDoc: string, currDoc: string): string {
  const msStart = (new Date()).getTime()
  const diff = dmp.diff_main(lastDoc, currDoc)
  // eslint-disable-next-line @typescript-eslint/camelcase
  const patch: patch_obj[] = dmp.patch_make(lastDoc, diff)
  const strPatch: string = dmp.patch_toText(patch)
  const msEnd = (new Date()).getTime()
  log('debug', strPatch)
  log('debug', (msEnd - msStart) + 'ms')
  return strPatch
}

class Data {
  msg: string
  cacheKey: string
  lastDoc?: string
  currDoc?: string
  revisions?: Revision[]
  count?: number
}

process.on('message', function (data: Data) {
  if (!data || !data.msg || !data.cacheKey) {
    return log('error', 'dmp worker error: not enough data')
  }
  switch (data.msg) {
    case 'create patch':
      if (data.lastDoc === undefined || data.currDoc === undefined) {
        return log('error', 'dmp worker error: not enough data on create patch')
      }
      try {
        const patch: string = createPatch(data.lastDoc, data.currDoc)
        processSend({
          msg: 'check',
          result: patch,
          cacheKey: data.cacheKey
        })
      } catch (err) {
        log('error', 'create patch: dmp worker error', err)
        processSend({
          msg: 'error',
          error: err,
          cacheKey: data.cacheKey
        })
      }
      break
    case 'get revision':
      if (data.revisions === undefined || data.count === undefined) {
        return log('error', 'dmp worker error: not enough data on get revision')
      }
      try {
      // eslint-disable-next-line @typescript-eslint/camelcase
        const result: { content: string; patch: patch_obj[]; authorship: string } = getRevision(data.revisions, data.count)
        processSend({
          msg: 'check',
          result: result,
          cacheKey: data.cacheKey
        })
      } catch (err) {
        log('error', 'get revision: dmp worker error', err)
        processSend({
          msg: 'error',
          error: err,
          cacheKey: data.cacheKey
        })
      }
      break
  }
})

// log uncaught exception
process.on('uncaughtException', function (err: Error) {
  log('error', 'An uncaught exception has occured.')
  log('error', err)
  log('error', 'Process will exit now.')
  process.exit(1)
})
