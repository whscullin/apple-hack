const DOS33 = require('./src/DOS33')
const fs = require('fs')

const data = fs.readFileSync('./tmp/test.dsk')
const disk = new DOS33(data)
const file = disk.files[1]
let dumpFile

const logo = `
              oM"Mo oo
               MMM"M"MM
oo            oooo MoMM  oo
MM           MMMMMoo"""  MM
MM          MM   "MM     MM
MM       o   "MMMoMMoo   MM           o        o
MM    oMMMMMo """MoMMMo  MM   oMM""ooMMMo   MMMM
MM   MM"" ""MM oMM" ""MM MM oMM"  oM"  ""Mo MM"
MM  MM      "MMMM      MMMMM"MM  MMMMMMMMMM"MM
MM   MM     oM MM     oMMMM"  MM "Mo     oo MM
"MMoo"MMoooMM"  MMoooMM" MM    "MM"Moo oMM" MM
"MMM  "MMM"     ""MM""  MM     "MM""MMM"   MM
`

dumpFile = disk.dumpFile(file)
console.log(dumpFile.toString())
disk.writeFile(file, {
  data: logo.split('').map(c => (c === '\n' ? 0x0d : c.charCodeAt(0) | 0x80))
})
dumpFile = disk.dumpFile(file)
console.log(dumpFile.toString())
fs.writeFileSync('./tmp/test-out.dsk', disk.data)

/*
REM HATS, 10
REM PANTS, 40
REM DRESSES, 70
REM SHOES, 60
REM SOCKS, 2
REM SHIRTS, 35
*/
