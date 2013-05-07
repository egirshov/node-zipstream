// written by Antoine van Wel (http://wellawaretech.com)
// ZIP64 support added by Eugene Girshov (http://www.f-secure.com)

var zlib = require('zlib');
var fs = require('fs');
var assert = require('assert');
var stream = require('stream');
var util = require('util');

var crc32 = require('./crc32');

var MAX_32BIT = 0x100000000; // 1 << 32

function ZipStream(opt) {
  var self = this;

  self.readable = true;
  self.paused = false;
  self.busy = false;
  self.eof = false;

  self.queue = [];
  self.fileptr = 0;
  self.files = [];
  self.options = opt;
  self.zip64 = false;
}

util.inherits(ZipStream, stream.Stream);

exports.createZip = function(opt) {
  return new ZipStream(opt);
}

// converts datetime to DOS format
function convertDate(d) {
  var year = d.getFullYear();

  if (year < 1980) {
    return (1<<21) | (1<<16);
  }
  return ((year-1980) << 25) | ((d.getMonth()+1) << 21) | (d.getDate() << 16) |
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
}


ZipStream.prototype.pause = function() {
  var self = this;
  self.paused = true;
}

ZipStream.prototype.resume = function() {
  var self = this;
  self.paused = false;

  self._read();
}

ZipStream.prototype.destroy = function() {
  var self = this;
  self.readable = false;
}

ZipStream.prototype._read = function() {
  var self = this;

  if (!self.readable || self.paused) { return; }

  if (self.queue.length > 0) {
    var data = self.queue.shift();
    self.emit('data', data);
  }

  if (self.eof && self.queue.length === 0) {
    self.emit('end');
    self.readable = false;

    if (self.callback) {
      self.callback(self.fileptr);
    }
  }

  process.nextTick(function() { self._read(); }); //TODO improve
}



ZipStream.prototype.finalize = function(callback) {
  var self = this;

  if (self.files.length === 0) {
    self.emit('error', 'no files in zip');
    return;
  }

  self.callback = callback;
  self._pushCentralDirectory();
  self.eof = true;
}


ZipStream.prototype._addFileStore = function(source, file, callback) {

}

ZipStream.prototype._addFileDeflate = function(source, file, callback) {

}

ZipStream.prototype.addFile = function(source, file, callback) {
  var self = this;

  if (self.busy) {
    self.emit('error', 'previous file not finished');
    return;
  }

  if (typeof source === 'string') {
    source = new Buffer(source, 'utf-8');
  }

  self.busy = true;
  self.file = file;
  self._pushLocalFileHeader(file);


  var checksum = crc32.createCRC32();
  file.uncompressed = 0;
  file.compressed = 0;


  function onEnd() {
    file.crc32 = checksum.digest();
    if (file.store) { file.compressed = file.uncompressed; }

    self.fileptr += file.compressed;
    self._pushDataDescriptor(file);

    self.files.push(file);
    self.busy = false;
    callback();
  }

  function update(chunk) {
    checksum.update(chunk);
    file.uncompressed += chunk.length;
  }

  if (file.store) {

    if (Buffer.isBuffer(source)) {
      update(source);

      self.queue.push(source);
      process.nextTick(onEnd);
    } else {
      // Assume stream
      source.on('data', function(chunk) {
        update(chunk);
        self.queue.push(chunk);
      });

      source.on('end', onEnd);
    }

  } else {

    var deflate = zlib.createDeflateRaw(self.options);

    deflate.on('data', function(chunk) {
      file.compressed += chunk.length;
      self.queue.push(chunk);
    });

    deflate.on('end', onEnd);

    if (Buffer.isBuffer(source)) {
      update(source);
      deflate.write(source);
      deflate.end();
    } else {
      // Assume stream
      source.on('data', function(chunk) {
        update(chunk);
        deflate.write(chunk); //TODO check for false & wait for drain
      });
      source.on('end', function() {
        deflate.end();
      });
    }
  }

  process.nextTick(function() { self._read(); });
}

//TODO remove listeners on end


// local file header
ZipStream.prototype._pushLocalFileHeader = function(file) {
  var self = this;

  file.version = 20;
  file.bitflag = (1<<3) | (1<<11);
  file.method = file.store ? 0 : 8;
  if (!file.date) { file.date = new Date(); }
  file.moddate = convertDate(file.date);
  file.offset = self.fileptr;

  var buf = new Buffer(1024);
  var len;

  buf.writeUInt32LE(0x04034b50, 0);         // local file header signature
  buf.writeUInt16LE(file.version, 4);       // version needed to extract
  buf.writeUInt16LE(file.bitflag, 6);       // general purpose bit flag
  buf.writeUInt16LE(file.method, 8);        // compression method
  buf.writeUInt32LE(file.moddate, 10);      // last mod file date and time
  buf.writeInt32LE(0, 14);                  // crc32
  buf.writeUInt32LE(0, 18);                 // compressed size
  buf.writeUInt32LE(0, 22);                 // uncompressed size
  len = buf.write(file.name, 30);           // file name
  buf.writeUInt16LE(len, 26);               // file name length

  len += 30;

  if (self.zip64) {
    // An empty extra field is written to indicate that Data Descriptor is ZIP64 long
    buf.writeUInt16LE(4, 28);               // extra field length
    buf.writeUInt16LE(0x0001, len);         // header ID: ZIP64
    buf.writeUInt16LE(0, len + 2);          // data size
    len += 4;
  } else {
    buf.writeUInt16LE(0, 28);               // extra field length
  }

  self.queue.push(buf.slice(0, len));
  self.fileptr += len;
}

ZipStream.prototype._pushDataDescriptor = function(file) {
  var self = this;
  var ddsize = self.zip64 ? 24 : 16;
  var buf = new Buffer(ddsize);
  buf.writeUInt32LE(0x08074b50, 0);         // data descriptor record signature
  buf.writeInt32LE(file.crc32, 4);          // crc-32

  if (self.zip64) {
    buf.writeUInt32LE(file.compessed >>> 0, 8);
    buf.writeUInt32LE(file.compressed / MAX_32BIT >>> 0, 12);
    buf.writeUInt32LE(file.uncompressed >>> 0, 16);
    buf.writeUInt32LE(file.uncompressed / MAX_32BIT >>> 0, 20);
  } else {
    buf.writeUInt32LE(file.compressed, 8);
    buf.writeUInt32LE(file.uncompressed, 12);
  }
  self.queue.push(buf);
  self.fileptr += buf.length;
}

ZipStream.prototype._pushCentralDirectoryFileHeader = function (index) {
  var self = this;
  var file = self.files[index];
  var buf = new Buffer(1024);
  var len;

  // central directory file header
  buf.writeUInt32LE(0x02014b50, 0);         // central file header signature
  buf.writeUInt16LE(file.version, 4);       // TODO version made by
  buf.writeUInt16LE(file.version, 6);       // version needed to extract
  buf.writeUInt16LE(file.bitflag, 8);       // general purpose bit flag
  buf.writeUInt16LE(file.method, 10);       // compression method
  buf.writeUInt32LE(file.moddate, 12);      // last mod file time and date
  buf.writeInt32LE(file.crc32, 16);         // crc-32

  buf.writeUInt16LE(0, 32);                 // file comment length
  buf.writeUInt16LE(0, 34);                 // disk number where file starts
  buf.writeUInt16LE(0, 36);                 // internal file attributes
  buf.writeUInt32LE(0, 38);                 // external file attributes

  len = buf.write(file.name, 46);           // file name
  buf.writeUInt16LE(len, 28);               // file name length

  len += 46;

  if (self.zip64) {
    buf.writeUInt32LE(0xFFFFFFFF, 20);      // compressed size
    buf.writeUInt32LE(0xFFFFFFFF, 24);      // uncompressed size
    buf.writeUInt32LE(0xFFFFFFFF, 42);      // relative offset

    var extra_size = 24;                    // original/compressed + relative offset
    buf.writeUInt16LE(extra_size + 4, 30);  // extra field length

    buf.writeUInt16LE(1, len);              // extra field id (ZIP64)
    buf.writeUInt16LE(extra_size, len + 2); // extra field size (not including this header)

    buf.writeUInt32LE(file.uncompressed >>> 0, len + 4);
    buf.writeUInt32LE(file.uncompressed / MAX_32BIT >>> 0, len + 8);
    buf.writeUInt32LE(file.compressed >>> 0, len + 12);
    buf.writeUInt32LE(file.compressed / MAX_32BIT >>> 0, len + 16);
    buf.writeUInt32LE(file.offset >>> 0, len + 20);
    buf.writeUInt32LE(file.offset / MAX_32BIT >>> 0, len + 24);

    len += extra_size + 4;
  } else {
    buf.writeUInt32LE(file.compressed, 20);   // compressed  size
    buf.writeUInt32LE(file.uncompressed, 24); // uncompressed size
    buf.writeUInt16LE(0, 30);                 // extra field length
    buf.writeUInt32LE(file.offset, 42);       // relative offset
  }

  self.queue.push(buf.slice(0, len));
  return len;
};

ZipStream.prototype._pushCentralDirectoryEnd = function (cdsize, cdoffset) {
  var self = this;
  // end of central directory record
  var len = 22;
  var buf = new Buffer(len);

  buf.writeUInt32LE(0x06054b50, 0);             // end of central dir signature
  buf.writeUInt16LE(0, 4);                      // number of this disk
  buf.writeUInt16LE(0, 6);                      // disk where central directory starts

  if (self.zip64) {
    // Actual values written to ZIP64 end of central directory record
    buf.writeUInt16LE(0xFFFF, 8);
    buf.writeUInt16LE(0xFFFF, 10);
    buf.writeUInt32LE(0xFFFFFFFF, 12);
    buf.writeUInt32LE(0xFFFFFFFF, 16);
  } else {
    buf.writeUInt16LE(self.files.length, 8);    // number of central directory records on this disk
    buf.writeUInt16LE(self.files.length, 10);   // total number of central directory records
    buf.writeUInt32LE(cdsize, 12);              // size of central directory in bytes
    buf.writeUInt32LE(cdoffset, 16);            // offset of start of central directory,
                                                // relative to start of archive
  }
  buf.writeUInt16LE(0, 20);                     // comment length

  self.queue.push(buf);
  return len;
};

ZipStream.prototype._pushZip64CdEndRecord = function (cdsize, cdoffset) {
  var self = this;
  var len = 56;
  var buf = Buffer(len)
  var sizeOfRecord = len - 12;              // size of record without first 12 bytes
                                            // (signature and 8-byte size field)

  buf.writeUInt32LE(0x06064b50, 0);         // zip64 end of central dir signature

  buf.writeUInt32LE(sizeOfRecord, 4);       // size of zip64 end of central directory record
  buf.writeUInt32LE(0, 8);                  // size of zip64 end of central directory record

  buf.writeUInt16LE(20, 12);                // version made by
  buf.writeUInt16LE(20, 14);                // version needed to extract

  buf.writeUInt32LE(0, 16);                 // number of this disk
  buf.writeUInt32LE(0, 20);                 // number of the disk where start of CD written

  var files_lo = self.files.length >>> 0;
  var files_hi = self.files.length / MAX_32BIT >>> 0;

  buf.writeUInt32LE(files_lo, 24);          // number of entries in CD on this disk
  buf.writeUInt32LE(files_hi, 28);
  buf.writeUInt32LE(files_lo, 32);          // number of entries in CD totally
  buf.writeUInt32LE(files_hi, 36);

  buf.writeUInt32LE(cdsize >>> 0, 40);      // size of CD
  buf.writeUInt32LE((cdsize / MAX_32BIT) >>> 0, 44);

  buf.writeUInt32LE(cdoffset >>> 0, 48)     // offset of CD
  buf.writeUInt32LE((cdoffset / MAX_32BIT) >>> 0, 52);

  self.queue.push(buf);
  return len;
};

ZipStream.prototype._pushZip64CdEndLocator = function (zip64offset) {
  var self = this;
  var len = 20;
  var buf = Buffer(len)

  buf.writeUInt32LE(0x07064b50, 0);           // zip64 end of central dir locator signature

  buf.writeUInt32LE(0, 4);                    // number of the disk with the start of the zip64 end of central directory

  buf.writeUInt32LE(zip64offset >>> 0, 8);    // relative offset of the zip64 end of central directory record
  buf.writeUInt32LE(zip64offset / MAX_32BIT >>> 0, 12);

  buf.writeUInt32LE(1, 16);                   // total number of disks

  self.queue.push(buf);
  return len;
};

ZipStream.prototype._pushCentralDirectory = function() {
  var self = this;
  var cdoffset = self.fileptr;
  var cdsize = 0;

  for (var i=0; i<self.files.length; i++) {
    cdsize += self._pushCentralDirectoryFileHeader(i)
  }
  self.fileptr += cdsize;

  if (self.zip64) {
    self.fileptr += self._pushZip64CdEndRecord(cdsize, cdoffset);
    self.fileptr += self._pushZip64CdEndLocator(cdoffset + cdsize);
  }

  self.fileptr += self._pushCentralDirectoryEnd(cdsize, cdoffset);
};
