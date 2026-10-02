#!/usr/bin/env node
// Fails when a commit in <base>..<head> uses a non-noreply email or adds a blocked term.
// Blocked terms come from the IDENTITY_BLOCKLIST secret (one per line), so this public file never lists them.
'use strict'
const { execFileSync } = require('node:child_process')

const BLOCKED = new Set((process.env.IDENTITY_BLOCKLIST || '').split(/[\n,]/).map(term => term.trim().toLowerCase()).filter(Boolean))
// Generated files whose hashes could contain a blocked word by chance.
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/
const EMAIL_HINT = "set git config user.email to your <id>+<login>@users.noreply.github.com address and enable 'Block command line pushes that expose my email' in GitHub email settings; then amend/rebase."
const TERM_HINT = 'remove the term from the commit message, file name or change; then amend/rebase.'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
const isNoreply = email => /@users\.noreply\.github\.com$/i.test(email) || /^noreply@/i.test(email)

// Blocked terms in text: whole email-like tokens, words, and the parts of camelCase words.
function blocked(text) {
  if (!BLOCKED.size) return false
  const emails = (text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+/g) || []).map(email => email.replace(/[.-]+$/, ''))
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
  return [...emails, ...words].some(token => BLOCKED.has(token))
}

// Added lines of a unified (or combined, for merges) diff, with their path and new line number.
function addedLines(diff) {
  const added = []
  let file = '', width = 0, line = 0
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff ')) width = 0
    else if (!width && text.startsWith('+++ ')) file = text.slice(4)
    else if (text.startsWith('@@')) [width, line] = [text.match(/^@+/)[0].length - 1, Number(text.match(/\+(\d+)(?:,\d+)? @/)[1])]
    else if (width && !text.startsWith('\\')) {
      const prefix = text.slice(0, width)
      if (prefix.includes('-')) continue
      if (prefix === '+'.repeat(width)) added.push({ file, line, text: text.slice(width) })
      line++
    }
  }
  return added
}

const range = process.argv[2] || ''
let [base, head] = range.split('..')
if (!base || !head || range.includes('...')) {
  console.error('Usage: identity-check.js <base>..<head>')
  process.exit(2)
}
if (/^0+$/.test(head)) {
  console.log(`Skipping ${range}: the branch was deleted.`)
  process.exit(0)
}
let revs = [`${base}..${head}`]
const known = sha => { try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }); return true } catch { return false } }
if (/^0+$/.test(base) || !known(base)) {
  // A new branch or a force push: there is no earlier commit to compare against, so check all of head.
  console.log(`No earlier commit for ${range}; checking every commit reachable from ${head.slice(0, 12)}.`)
  revs = [head]
}
if (!BLOCKED.size) console.log('IDENTITY_BLOCKLIST is not set; checking emails only.')

let emailProblems = 0, termProblems = 0
const commits = git('rev-list', '--reverse', ...revs).split('\n').filter(Boolean)
for (const sha of commits) {
  const short = sha.slice(0, 12)
  const [author, committer, message, ...rest] = git('show', '--format=%ae%x00%ce%x00%B%x00', '--unified=0', '--no-prefix', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', sha).split('\0')
  const emails = [['author email', author], ['committer email', committer]]
  for (const [, value] of message.matchAll(/^co-authored-by:(.*)$/gim)) for (const email of value.match(/[^\s<>]+@[^\s<>]+/g) || []) emails.push(['Co-authored-by trailer email', email])
  for (const [field, email] of emails) if (!isNoreply(email)) {
    emailProblems++
    console.log(`${short}: ${field} is not a noreply address`)
  }
  if (!BLOCKED.size) continue
  if (blocked(message)) {
    termProblems++
    console.log(`${short}: blocked term in the commit message`)
  }
  const paths = git('show', '--format=', '--name-only', '-M', sha).split('\n').filter(Boolean)
  if (paths.some(blocked)) {
    termProblems++
    console.log(`${short}: blocked term in a changed file name`)
  }
  for (const { file, line, text } of addedLines(rest.join('\0'))) if (!GENERATED.test(file) && blocked(text)) {
    termProblems++
    console.log(`${short}: blocked term in added line ${blocked(file) ? '<file name hidden>' : file}:${line}`)
  }
}

if (emailProblems) console.log(`\nTo fix the email: ${EMAIL_HINT}`)
if (termProblems) console.log(`\nTo fix the term: ${TERM_HINT}`)
console.log(`\nChecked ${commits.length} commit(s): ${emailProblems + termProblems ? `${emailProblems + termProblems} problem(s).` : 'OK.'}`)
process.exit(emailProblems + termProblems ? 1 : 0)
