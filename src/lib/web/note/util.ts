import { Request, Response } from 'express'
import fs from 'fs'

import path from 'path'
import { config } from '../../config'
import { errors } from '../../errors'
import { logger } from '../../logger'
import { Note } from '../../models'
import { PhotoProfile } from '../../utils/PhotoProfile'

export function newNote (req, res: Response, body: string | null): void {
  let owner = null
  const noteId = req.params.noteId ? req.params.noteId : null
  if (req.isAuthenticated()) {
    owner = req.user.id
  } else if (!config.allowAnonymous) {
    return errors.errorForbidden(res)
  }
  if (config.allowFreeURL && noteId && !config.forbiddenNoteIDs.includes(noteId)) {
    req.alias = noteId
  } else if (noteId) {
    return req.method === 'POST' ? errors.errorForbidden(res) : errors.errorNotFound(res)
  }
  Note.create({
    ownerId: owner,
    alias: req.alias ? req.alias : null,
    content: body
  }).then(function (note) {
    return res.redirect(config.serverURL + '/' + (note.alias ? note.alias : Note.encodeNoteId(note.id)))
  }).catch(function (err) {
    logger.error(err)
    return errors.errorInternalError(res)
  })
}

export enum Permission {
    None,
    Read,
    Write,
    Owner
}

interface NoteObject {
  ownerId?: string;
  permission: string;
  alias: string;
}

export function getPermission (user, note: NoteObject): Permission {
  // There are two possible User objects we get passed. One is from socket.io
  // and the other is from passport directly. The former sets the logged_in
  // parameter to either true or false, whereas for the latter, the logged_in
  // parameter is always undefined, and the existence of user itself means the
  // user is logged in.
  if (note.alias !== null && note.alias.startsWith('sysadmin')) {
    if (!user || user.logged_in === false) {
      return Permission.None
    } if (note.ownerId === user.id) {
      return Permission.Owner
    } else {
      const profile = JSON.parse(user.profile)
      if (profile.groups !== undefined && profile.groups.includes('srcf-admin')) {
        return Permission.Write
      } else {
        return Permission.None
      }
    }
  }

  if (!user || user.logged_in === false) {
    // Anonymous
    switch (note.permission) {
      case 'freely':
        return Permission.Write
      case 'editable':
      case 'locked':
        return Permission.Read
      default:
        return Permission.None
    }
  } else if (note.ownerId === user.id) {
    // Owner
    return Permission.Owner
  } else {
    // Registered user
    switch (note.permission) {
      case 'editable':
      case 'limited':
      case 'freely':
        return Permission.Write
      case 'locked':
      case 'protected':
        return Permission.Read
      default:
        return Permission.None
    }
  }
}

export function findNoteOrCreate (req: Request, res: Response, callback: (note: Note) => void): void {
  const id = req.params.noteId || req.params.shortid
  Note.parseNoteId(id, function (err, _id) {
    if (err) {
      logger.error(err)
      return errors.errorInternalError(res)
    }
    Note.findOne({
      where: {
        id: _id
      }
    }).then(function (note) {
      if (!note) {
        return newNote(req, res, '')
      }
      if (getPermission(req.user, note) === Permission.None) {
        return errors.errorForbidden(res)
      } else {
        return callback(note)
      }
    }).catch(function (err) {
      logger.error(err)
      return errors.errorInternalError(res)
    })
  })
}

function isRevealTheme (theme: string): string | undefined {
  if (fs.existsSync(path.join(__dirname, '..', '..', '..', '..', 'public', 'build', 'reveal.js', 'css', 'theme', theme + '.css'))) {
    return theme
  }
  return undefined
}

export function getPublishData (req: Request, res: Response, note, callback: (data) => void): void {
  const body = note.content
  const extracted = Note.extractMeta(body)
  const markdown = extracted.markdown
  const meta = Note.parseMeta(extracted.meta)
  const createtime = note.createdAt
  const updatetime = note.lastchangeAt
  let title = Note.decodeTitle(note.title)
  title = Note.generateWebTitle(meta.title || title)
  const ogdata = Note.parseOpengraph(meta, title)
  const data = {
    title: title,
    description: meta.description || (markdown ? Note.generateDescription(markdown) : null),
    viewcount: note.viewcount,
    createtime: createtime,
    updatetime: updatetime,
    body: markdown,
    theme: meta.slideOptions && isRevealTheme(meta.slideOptions.theme),
    meta: JSON.stringify(extracted.meta),
    owner: note.owner ? note.owner.id : null,
    ownerprofile: note.owner ? PhotoProfile.fromUser(note.owner) : null,
    lastchangeuser: note.lastchangeuser ? note.lastchangeuser.id : null,
    lastchangeuserprofile: note.lastchangeuser ? PhotoProfile.fromUser(note.lastchangeuser) : null,
    robots: meta.robots || false, // default allow robots
    GA: meta.GA,
    disqus: meta.disqus,
    cspNonce: res.locals.nonce,
    dnt: req.headers.dnt,
    opengraph: ogdata
  }
  callback(data)
}
