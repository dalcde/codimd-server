import { ChildProcess } from 'child_process'

import Sequelize from 'sequelize'
import { BelongsTo, Column, DataType, Default, ForeignKey, Model, PrimaryKey, Table } from 'sequelize-typescript'
// core
import { logger } from '../logger'
import { processData, stripNullByte } from '../utils/functions'
import { Note } from './note'
import async = require('async')
import childProcess = require('child_process')
import moment = require('moment')
import path = require('path')
import shortId = require('shortid')

const Op = Sequelize.Op

const dmpCallbackCache = {}

class Data {
  msg
  cacheKey
  error
  result
  level
}

function createDmpWorker (): ChildProcess {
  const worker = childProcess.fork(path.resolve(__dirname, '../workers/dmpWorker'), ['ignore'])
  logger.debug('dmp worker process started')
  worker.on('message', function (data: Data) {
    if (!data || !data.msg || !data.cacheKey) {
      logger.error('dmp worker error: not enough data on message')
      return
    }
    const cacheKey = data.cacheKey
    switch (data.msg) {
      case 'log':
        logger.log(data.level, data.result[0], ...data.result[1])
        // The cacheKey is a dummy value and we want to skip the delete line.
        return
      case 'error':
        dmpCallbackCache[cacheKey](data.error, null)
        break
      case 'check':
        dmpCallbackCache[cacheKey](null, data.result)
        break
    }
    delete dmpCallbackCache[cacheKey]
  })
  worker.on('close', function (code) {
    logger.debug(`dmp worker process exited with code ${code}`)
  })
  return worker
}

let dmpWorker: ChildProcess = createDmpWorker()

function sendDmpWorker (data, callback): void {
  if (!dmpWorker) {
    dmpWorker = createDmpWorker()
  }
  const cacheKey = Date.now() + '_' + shortId.generate()
  dmpCallbackCache[cacheKey] = callback
  data = Object.assign(data, {
    cacheKey: cacheKey
  })
  dmpWorker.send(data)
}

@Table
export class Revision extends Model<Revision> {
  @Default(Sequelize.UUIDV4)
  @PrimaryKey
  @Column(DataType.UUID)
  id: string

  @Column(DataType.INTEGER)
  length: number

  @ForeignKey(() => Note)
  @Column(DataType.UUID)
  noteId: string

  @BelongsTo(() => Note, { foreignKey: 'noteId', constraints: false, onDelete: 'CASCADE', hooks: true })
  note: Note

  @Column(DataType.TEXT({ length: 'long' }))
  get patch (): string {
    return this.getDataValue('patch') ?? ''
  }

  set patch (value: string) {
    this.setDataValue('patch', stripNullByte(value))
  }

  @Column(DataType.TEXT({ length: 'long' }))
  get lastContent (): string {
    return this.getDataValue('lastContent') ?? ''
  }

  set lastContent (value: string) {
    this.setDataValue('lastContent', stripNullByte(value))
  }

  @Column(DataType.TEXT({ length: 'long' }))
  get content (): string {
    return this.getDataValue('content') ?? ''
  }

  set content (value: string) {
    this.setDataValue('content', stripNullByte(value))
  }

  @Column(DataType.TEXT({ length: 'long' }))
  get authorship (): string {
    return processData(this.getDataValue('authorship'), [], JSON.parse)
  }

  set authorship (value: string) {
    this.setDataValue('authorship', value ? JSON.stringify(value) : value)
  }

  static getNoteRevisions (note: Note, callback): void {
    Revision.findAll({
      where: {
        noteId: note.id
      },
      order: [['createdAt', 'DESC']]
    }).then(function (revisions: Revision[]) {
      class RevisionDataActions { // TODO: Fix Type in actions.ts
        time

        length
      }

      const data: RevisionDataActions[] = []
      revisions.forEach(function (revision: Revision) {
        data.push({
          time: moment(revision.createdAt).valueOf(),
          length: revision.length
        })
      })
      callback(null, data)
    }).catch(function (err) {
      callback(err, null)
    })
  }

  static getPatchedNoteRevisionByTime (note: Note, time, errorCallback): void {
    // find all revisions to prepare for all possible calculation
    Revision.findAll({
      where: {
        noteId: note.id
      },
      order: [['createdAt', 'DESC']]
    }).then(function (revisions: Revision[]) {
      if (revisions.length <= 0) {
        errorCallback(null, null)
        return
      }
      // measure target revision position
      Revision.count({
        where: {
          noteId: note.id,
          createdAt: {
            [Op.gte]: time
          }
        }
      }).then(function (count: number) {
        if (count <= 0) {
          errorCallback(null, null)
          return
        }
        sendDmpWorker({
          msg: 'get revision',
          revisions: revisions,
          count: count
        }, errorCallback)
      }).catch(function (err) {
        errorCallback(err, null)
      })
    }).catch(function (err) {
      errorCallback(err, null)
    })
  }

  static checkAllNotesRevision (callback): void {
    Revision.saveAllNotesRevision(function (err, notes: Note[]) {
      if (err) {
        callback(err, null)
        return
      }
      if (!notes || notes.length <= 0) {
        callback(null, notes)
      } else {
        Revision.checkAllNotesRevision(callback)
      }
    })
  }

  static saveAllNotesRevision (callback): void {
    Note.findAll({
      // query all notes that need to save for revision
      where: {
        [Op.and]: [
          {
            lastchangeAt: {
              [Op.or]: {
                [Op.eq]: null,
                [Op.and]: {
                  [Op.ne]: null,
                  [Op.gt]: Sequelize.col('createdAt')
                }
              }
            }
          },
          {
            savedAt: {
              [Op.or]: {
                [Op.eq]: null,
                [Op.lt]: Sequelize.col('lastchangeAt')
              }
            }
          }
        ]
      }
    }).then(function (notes: Note[]) {
      if (notes.length <= 0) {
        callback(null, notes)
        return
      }
      const savedNotes: Note[] = []
      async.each(notes, function (note: Note, _callback) {
        // revision saving policy: note not been modified for 5 mins or not save for 10 mins
        if (note.lastchangeAt && note.savedAt) {
          const lastchangeAt = moment(note.lastchangeAt)
          const savedAt = moment(note.savedAt)
          if (moment().isAfter(lastchangeAt.add(5, 'minutes'))) {
            savedNotes.push(note)
            Revision.saveNoteRevision(note, _callback)
          } else if (lastchangeAt.isAfter(savedAt.add(10, 'minutes'))) {
            savedNotes.push(note)
            Revision.saveNoteRevision(note, _callback)
          } else {
            _callback(null, null)
          }
        } else {
          savedNotes.push(note)
          Revision.saveNoteRevision(note, _callback)
        }
      }, function (err) {
        if (err) {
          callback(err, null)
          return
        }
        // return null when no notes need saving at this moment but have delayed tasks to be done
        const result = ((savedNotes.length === 0) && (notes.length > 0)) ? null : savedNotes
        callback(null, result)
      })
    }).catch(function (err) {
      callback(err, null)
    })
  }

  static saveNoteRevision (note: Note, callback): void {
    Revision.findAll({
      where: {
        noteId: note.id
      },
      order: [['createdAt', 'DESC']]
    }).then(function (revisions: Revision[]) {
      if (revisions.length <= 0) {
        // if no revision available
        let noteContent = note.content
        if (noteContent.length === 0) {
          noteContent = ''
        }
        Revision.create({
          noteId: note.id,
          lastContent: noteContent,
          length: noteContent.length,
          authorship: note.authorship
        }).then(function (revision: Revision) {
          Revision.finishSaveNoteRevision(note, revision, callback)
        }).catch(function (err) {
          callback(err, null)
        })
      } else {
        const latestRevision = revisions[0]
        const lastContent = latestRevision.content || latestRevision.lastContent
        const content = note.content
        sendDmpWorker({
          msg: 'create patch',
          lastDoc: lastContent,
          currDoc: content
        }, function (err, patch) {
          if (err) {
            logger.error('save note revision error', err)
            return
          }
          if (!patch) {
            // if patch is empty (means no difference) then just update the latest revision updated time
            latestRevision.changed('updatedAt', true)
            latestRevision.update({
              updatedAt: Date.now()
            }).then(function (revision: Revision) {
              Revision.finishSaveNoteRevision(note, revision, callback)
            }).catch(function (err) {
              callback(err, null)
            })
          } else {
            Revision.create({
              noteId: note.id,
              patch: patch,
              content: note.content,
              length: note.content.length,
              authorship: note.authorship
            }).then(function (revision: Revision) {
              // clear last revision content to reduce db size
              latestRevision.update({
                content: null
              }).then(function () {
                Revision.finishSaveNoteRevision(note, revision, callback)
              }).catch(function (err) {
                callback(err, null)
              })
            }).catch(function (err) {
              callback(err, null)
            })
          }
        })
      }
    }).catch(function (err) {
      callback(err, null)
    })
  }

  static finishSaveNoteRevision (note: Note, revision: Revision, callback): void {
    note.update({
      savedAt: revision.updatedAt
    }).then(function () {
      callback(null, revision)
    }).catch(function (err) {
      callback(err, null)
    })
  }
}
