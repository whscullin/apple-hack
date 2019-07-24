const debug = require('debug')('apple2:disk')
const { toHex } = require('./utils')
const ApplesoftDump = require('./applesoft')
const IntegerBASICDump = require('./intbasic')
const findLastIndex = require('lodash/findLastIndex')

// const DO = [
//   0x0, 0xD, 0xB, 0x9, 0x7, 0x5, 0x3, 0x1,
//   0xE, 0xC, 0xA, 0x8, 0x6, 0x4, 0x2, 0xF
// ]

class DOS33 {
  constructor (data, format = 'do') {
    this.format = format
    this.data = data
    this.vtoc = this.readVolumeTOC()
    this.files = this.readCatalog()
  }

  rwts (track, sector, data) {
    let start
    let end
    let result
    switch (this.format) {
      case 'do':
      case 'dsk':
        start = (track * 16 + sector) * 256
        end = start + 256
        if (data) {
          result = Buffer.from(data)
          this.data.fill(result, start, end)
        } else {
          result = this.data.slice(start, end)
        }
    }
    return [...result]
  }

  dumpSector (track, sector) {
    let result = ''
    const data = this.rwts(track, sector)
    let b, idx, jdx
    for (idx = 0; idx < 16; idx++) {
      result += toHex(idx << 4) + ': '
      for (jdx = 0; jdx < 16; jdx++) {
        b = data[idx * 16 + jdx]
        result += toHex(b) + ' '
      }
      result += '        '
      for (jdx = 0; jdx < 16; jdx++) {
        b = data[idx * 16 + jdx] & 0x7f
        if (b >= 0x20 && b < 0x7f) {
          result += String.fromCharCode(b)
        } else {
          result += '.'
        }
      }
      result += '\n'
    }
    return result
  }

  readFileTrackSectorList (file, full) {
    const fileTrackSectorList = []
    let { track, sector } = file.trackSectorList
    while (track || sector) {
      if (full) {
        fileTrackSectorList.push({ track, sector })
      }
      let jdx = 0 // offset in sector
      const data = this.rwts(track, sector)
      track = data[0x01]
      sector = data[0x02]
      let offset = 0x0C // offset in data
      while ((data[offset] || data[offset + 1]) && jdx < 121) {
        fileTrackSectorList.push({
          track: data[offset],
          sector: data[offset + 1]
        })
        offset += 2
        jdx++
      }
    }
    return fileTrackSectorList
  }

  readFile (file) {
    let data = []
    let idx
    const fileTrackSectorList = this.readFileTrackSectorList(file)
    for (idx = 0; idx < fileTrackSectorList.length; idx++) {
      const { track, sector } = fileTrackSectorList[idx]
      data = data.concat(this.rwts(track, sector))
    }
    let offset = 0
    let length = 0
    let address = 0

    switch (file.type) {
      case 'I':
      case 'A':
        offset = 2
        length = data[0] | data[1] << 8
        break
      case 'T':
        length = 0
        while (data[length]) { length++ }
        break
      case 'B':
        offset = 4
        address = data[0] | data[1] << 8
        length = data[2] | data[3] << 8
        break
    }

    data = data.slice(offset, offset + length)

    return { data, address, length }
  }

  allocateSector () {
    const { vtoc } = this
    const findSector = (track) => {
      const sectorMap = vtoc.trackSectorMap[track]
      return findLastIndex(sectorMap, sector => sector)
    }

    const lastTrack = vtoc.lastAllocationTrack
    let track = lastTrack
    let sector = findSector(track)
    while (sector === -1) {
      if (vtoc.allocationDirection === 0x01) {
        track = track - 1
        if (track < 0) {
          track = 0x12
          vtoc.allocationDirection = 0xff
        }
      } else {
        track = track + 1
        if (track >= vtoc.trackCount) {
          throw new Error('Insufficient free space')
        }
      }
      sector = findSector(track)
    }

    vtoc.lastAllocationTrack = track
    vtoc.trackSectorMap[track][sector] = false

    return { track, sector }
  }

  freeSector (track, sector) {
    this.vtoc.trackSectorMap[track][sector] = true
  }

  writeFile (file, fileData) {
    let prefix = []
    let { data } = fileData
    switch (file.type) {
      case 'A':
      case 'I':
        prefix = [
          data.length % 0x100,
          data.length >> 8
        ]
        break
      case 'B':
        prefix = [
          fileData.address % 0x100,
          fileData.address >> 8,
          data.length % 0x100,
          data.length >> 8
        ]
        break
    }
    data = prefix.concat(data)

    const dataRequiredSectors = Math.ceil(data.length / this.vtoc.sectorByteCount)
    const fileSectorListRequiredSectors = Math.ceil(dataRequiredSectors / 191)
    const requiredSectors = dataRequiredSectors + fileSectorListRequiredSectors
    let idx
    let sectors = []

    if (file.trackSectorList) {
      sectors = this.readFileTrackSectorList(file, true)
    }
    if (sectors.length > requiredSectors) {
      for (idx = requiredSectors; idx < sectors.length; idx++) {
        const { track, sector } = sectors[idx]
        this.freeSector(track, sector)
      }
      sectors = sectors.slice(0, requiredSectors)
    }
    if (sectors.length < requiredSectors) {
      for (idx = sectors.length; idx < requiredSectors; idx++) {
        sectors.push(this.allocateSector())
      }
    }
    file.trackSectorList = { ...sectors[0] }
    file.size = requiredSectors

    let jdx = 0
    let lastTrackSectorList = null

    for (idx = 0; idx < dataRequiredSectors; idx++) {
      let sector
      let sectorData

      if (idx % 191 === 0) {
        sector = sectors.shift()
        sectorData = new Array(0x100).fill(0)
        if (lastTrackSectorList) {
          lastTrackSectorList[0x01] = sector.track
          lastTrackSectorList[0x02] = sector.sector
        }
        sectorData[0x05] = idx & 0xff
        sectorData[0x06] = idx >> 8
        for (jdx = 0; jdx < 191 && jdx < sectors.length; jdx++) {
          const offset = 0xC + jdx * 2
          sectorData[offset] = sectors[jdx].track
          sectorData[offset + 1] = sectors[jdx].sector
        }
        lastTrackSectorList = sectorData
        this.rwts(sector.track, sector.sector, sectorData)
      }

      sector = sectors.shift()
      sectorData = new Array(0x100).fill(0)
      sectorData.splice(0, data.length, ...data)
      data = data.slice(0x100)
      this.rwts(sector.track, sector.sector, sectorData)
    }
    this.writeVolumeTOC()
    this.writeCatalog()
  }

  dumpFile (file) {
    let result = null
    const fileData = this.readFile(file)
    switch (file.type) {
      case 'A':
        result = new ApplesoftDump(fileData)
        break
      case 'I':
        result = new IntegerBASICDump(fileData)
        break
      case 'T':
        result = ''
        for (let idx = 0; idx < fileData.data.length; idx++) {
          const char = fileData.data[idx] & 0x7f
          if (char < 0x20) {
            if (char === 0xd) { // CR
              result += '\n'
            } else {
              result += `$${toHex(char)}`
            }
          } else {
            result += String.fromCharCode(char)
          }
        }
        break
      case 'B':
      default:
        result = ''
        for (let idx = 0; idx < fileData.data.length; idx++) {
          if (idx % 16 === 0) {
            if (idx !== 0) {
              result += '\n'
            }
            result += `${toHex(fileData.address + idx, 4)}:`
          }
          result += ` ${toHex(fileData.data[idx])}`
        }
        result += '\n'
        break
    }
    return result
  }

  readVolumeTOC () {
    const data = this.rwts(0x11, 0x0)
    const vtoc = {
      catalog: {
        track: data[0x01],
        sector: data[0x02]
      },
      version: data[0x03],
      volume: data[0x06],
      trackSectorListSize: data[0x27],
      lastAllocationTrack: data[0x30],
      allocationDirection: data[0x31],
      trackCount: data[0x34],
      sectorCount: data[0x35],
      sectorByteCount: data[0x36] | data[0x37] << 8,
      trackSectorMap: []
    }

    for (let idx = 0; idx < vtoc.trackCount; idx++) {
      const sectorMap = []
      const offset = 0x38 + idx * 4
      let bitmap =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3]

      for (let jdx = 0; jdx < vtoc.sectorCount; jdx++) {
        sectorMap.unshift(!!(bitmap & 0x80000000))
        bitmap <<= 1
      }
      vtoc.trackSectorMap.push(sectorMap)
    }

    debug('DISK VOLUME ' + vtoc.volume)

    return vtoc
  }

  writeVolumeTOC () {
    const { vtoc } = this
    const data = new Array(0x100).fill(0)
    data[0x01] = vtoc.catalog.track
    data[0x02] = vtoc.catalog.sector
    data[0x03] = vtoc.version || 3
    data[0x06] = vtoc.volume || 0xFE
    data[0x27] = vtoc.trackSectorListSize || 0x7a
    data[0x30] = vtoc.lastAllocationTrack
    data[0x31] = vtoc.allocationDirection
    data[0x34] = vtoc.trackCount
    data[0x35] = vtoc.sectorCount
    data[0x36] = vtoc.sectorByteCount & 0xff
    data[0x37] = vtoc.sectorByteCount >> 8

    for (let idx = 0; idx < vtoc.trackSectorMap.length; idx++) {
      const offset = 0x38 + idx * 4
      const sectorMap = vtoc.trackSectorMap[idx]

      let mask = 0
      for (let jdx = 0; jdx < sectorMap.length; jdx++) {
        mask >>= 1
        if (sectorMap[jdx]) {
          mask |= 0x80000000
        }
      }

      data[offset] = (mask >> 24) & 0xff
      data[offset + 1] = (mask >> 16) & 0xff
      data[offset + 2] = (mask >> 8) & 0xff
      data[offset + 3] = mask & 0xff
    }
    this.rwts(0x11, 0x00, data)
  }

  readCatalog () {
    const { catalog } = this.vtoc
    const files = []

    let catTrack = catalog.track
    let catSector = catalog.sector
    while (catSector || catTrack) {
      const data = this.rwts(catTrack, catSector)

      catTrack = data[0x01]
      catSector = data[0x02]

      for (let idx = 0x0b; idx < 0x100; idx += 0x23) {
        const file = {
          locked: false,
          type: 'A',
          size: 0,
          name: ''
        }
        let str = ''
        const entry = data.slice(idx, idx + 0x23)

        if (!entry[0x00]) {
          continue
        }

        file.trackSectorList = {
          track: entry[0x00],
          sector: entry[0x01]
        }

        // Locked
        if (entry[0x02] & 0x80) {
          file.locked = true
        }

        if (file.locked) {
          str += '*'
        } else {
          str += ' '
        }

        // File type
        switch (entry[0x02 & 0x7f]) {
          case 0x00:
            file.type = 'T'
            break
          case 0x01:
            file.type = 'I'
            break
          case 0x02:
            file.type = 'A'
            break
          case 0x04:
            file.type = 'B'
            break
          case 0x08:
            file.type = 'S'
            break
          case 0x10:
            file.type = 'R'
            break
          case 0x20:
            file.type = 'A'
            break
          case 0x40:
            file.type = 'B'
            break
        }
        str += file.type
        str += ' '

        // Size
        file.size = entry[0x21] | entry[0x22] << 8
        str += parseInt(file.size / 100, 10)
        str += parseInt(file.size / 10, 10) % 10
        str += file.size % 10
        str += ' '

        // Filename
        for (let jdx = 0x03; jdx < 0x21; jdx++) {
          file.name += String.fromCharCode(entry[jdx] & 0x7f)
        }
        str += file.name
        debug(str)
        files.push(file)
      }
    }
    return files
  }

  writeCatalog () {
    const { catalog } = this.vtoc

    let catTrack = catalog.track
    let catSector = catalog.sector
    while (catSector || catTrack) {
      const data = this.rwts(catTrack, catSector)

      for (let idx = 0x0b; idx < 0x100; idx += 0x23) {
        const file = this.files.shift()

        if (!file) {
          continue
        }

        data[idx + 0x00] = file.trackSectorList.track
        data[idx + 0x01] = file.trackSectorList.sector

        data[idx + 0x02] = file.locked ? 0x80 : 0x00

        // File type
        switch (file.type) {
          case 'T':
            break
          case 'I':
            data[idx + 0x02] |= 0x01
            break
          case 'A':
            data[idx + 0x02] |= 0x02
            break
          case 'B':
            data[idx + 0x02] |= 0x04
            break
          case 'S':
            data[idx + 0x02] |= 0x08
            break
          case 'R':
            data[idx + 0x02] |= 0x10
            break
        }

        // Size
        data[idx + 0x21] = file.size & 0xff
        data[idx + 0x22] = file.size >> 8

        // Filename
        for (let jdx = 0; jdx < 0x1E; jdx++) {
          data[idx + 0x03 + jdx] = file.name.charCodeAt(jdx) | 0x80
        }
      }
      this.rwts(catTrack, catSector, data)

      catTrack = data[0x01]
      catSector = data[0x02]
    }
  }
}

module.exports = DOS33
