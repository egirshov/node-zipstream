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

  self.fileptr = 0;
  self.files = [];
  self.options = opt;
  self.zip64 = false;
  self.error = false;
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

ZipStream.prototype._pause = function () {
  var self = this;
  if (self.source && self.source.pause && self.source.resume) {
    self.source.pause();
    self.source_paused = true;
  }
}

ZipStream.prototype._resume = function () {
  var self = this;
  if (self.source && self.source_paused) {
    self.source.resume();
    self.source_paused = false;
  }
}

ZipStream.prototype.pause = function() {
  var self = this;
  self.paused = true;
  self._pause();
}

ZipStream.prototype.resume = function() {
  var self = this;
  if (self.paused) {
    self.paused = false;
    self._resume();
  }
}

ZipStream.prototype.destroy = function() {
  var self = this;
  self.readable = false;
}

ZipStream.prototype._write = function (chunk) {
  this.emit('data', chunk);
};

ZipStream.prototype._emitError = function (message) {
  if (this.error || this.eof) {
    return;
  }
  this.error = true;
  this.emit('error', new Error(message));
};

ZipStream.prototype.finalize = function(callback) {
  var self = this;
  if (self.error || self.eof)
    return;
  self._pushCentralDirectory();

  self.eof = true;
  self.readable = false;

  process.nextTick(function () {
    self.emit('end');

    if (callback) {
      callback(self.fileptr);
    }
  });
}


ZipStream.prototype._addFileStore = function(source, file, callback) {

}

ZipStream.prototype._addFileDeflate = function(source, file, callback) {

}

ZipStream.prototype.addFile = function(source, file, callback) {
  var self = this;

  if (self.busy) {
    self._emitError('previous file not finished');
    return;
  }
  if (!file.name) {
    self._emitError('empty filename');
    return;
  }

  if (typeof source === 'string') {
    source = new Buffer(source, 'utf-8');
  }

  self.busy = true;
  self.file = file;
  if (!self._pushLocalFileHeader(file))
    return;

  var checksum = crc32.createCRC32();
  file.uncompressed = 0;
  file.compressed = 0;

  function onEnd() {
    if (self.error) {
      self.readable = false;
      return;
    }
    file.crc32 = checksum.digest();
    if (file.store) { file.compressed = file.uncompressed; }

    self.fileptr += file.compressed;
    self._pushDataDescriptor(file);

    self.files.push(file);
    self.busy = false;
    self.source = null;
    callback();
  }

  function update(chunk) {
    checksum.update(chunk);
    file.uncompressed += chunk.length;
  }

  if (file.store) {

    if (Buffer.isBuffer(source)) {
      update(source);
      self._write(source);
      process.nextTick(onEnd);
    } else {
      self.source = source;
      // Assume stream
      source.on('data', function(chunk) {
        update(chunk);
        self._write(chunk);
      });

      source.on('end', onEnd);
    }

  } else {

    var deflate = zlib.createDeflateRaw(self.options);

    deflate.on('data', function(chunk) {
      file.compressed += chunk.length;
      self._write(chunk);
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
}

ZipStream.prototype.addDirectory = function(file, callback) {
  var self = this;

  if (self.busy) {
    self._emitError('previous file not finished');
    return;
  }
  if (!file.name) {
    self._emitError('empty filename');
    return;
  }

  self.busy = true;
  file.store = true;
  file.crc32 = 0;
  file.uncompressed = 0;
  file.compressed = 0;

  if (file.name[file.name.length - 1] !== '/') {
      file.name += '/';
  }
  if (!self._pushLocalFileHeader(file))
    return;
  self._pushDataDescriptor(file);

  self.files.push(file);

  process.nextTick(function () {
    self.busy = false;
    callback();
  });
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

  var filenameBuffer = Buffer.isBuffer(file.name) ? file.name : new Buffer(file.name);
  var filenameLength = filenameBuffer.length;
  if (filenameLength > 0xFFFF) {
      self._emitError('file name too long');
      return false;
  }

  // 30 bytes for the local header, 4 bytes extra ZIP64 field
  var len = filenameLength + 30 + (self.zip64 ? 4 : 0);
  var buf = new Buffer(len);

  buf.writeUInt32LE(0x04034b50, 0);         // local file header signature
  buf.writeUInt16LE(file.version, 4);       // version needed to extract
  buf.writeUInt16LE(file.bitflag, 6);       // general purpose bit flag
  buf.writeUInt16LE(file.method, 8);        // compression method
  buf.writeUInt32LE(file.moddate, 10);      // last mod file date and time
  buf.writeInt32LE(0, 14);                  // crc32
  buf.writeUInt32LE(0, 18);                 // compressed size
  buf.writeUInt32LE(0, 22);                 // uncompressed size
  buf.writeUInt16LE(filenameLength, 26);    // file name length
  filenameBuffer.copy(buf, 30);             // file name

  if (self.zip64) {
    // An empty extra field is written to indicate that Data Descriptor is ZIP64 long
    buf.writeUInt16LE(4, 28);                          // extra field length
    buf.writeUInt16LE(0x0001, filenameLength + 30);    // header ID: ZIP64
    buf.writeUInt16LE(0, filenameLength + 32);         // data size
  } else {
    buf.writeUInt16LE(0, 28);                          // extra field length
  }

  self._write(buf);
  self.fileptr += len;
  return true;
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
  self._write(buf);
  self.fileptr += buf.length;
}

ZipStream.prototype._pushCentralDirectoryFileHeader = function (index) {
  var self = this;
  var file = self.files[index];

  var filenameBuffer = Buffer.isBuffer(file.name) ? file.name : new Buffer(file.name);
  var filenameLength = filenameBuffer.length;
  // 46 bytes for the file header + 28 for ZIP64 extra field
  var len = filenameLength + 46 + (self.zip64 ? 28 : 0);
  var buf = new Buffer(len);

  // central directory file header
  buf.writeUInt32LE(0x02014b50, 0);         // central file header signature
  buf.writeUInt16LE(file.version, 4);       // TODO version made by
  buf.writeUInt16LE(file.version, 6);       // version needed to extract
  buf.writeUInt16LE(file.bitflag, 8);       // general purpose bit flag
  buf.writeUInt16LE(file.method, 10);       // compression method
  buf.writeUInt32LE(file.moddate, 12);      // last mod file time and date
  buf.writeInt32LE(file.crc32, 16);         // crc-32
  buf.writeUInt16LE(filenameLength, 28);    // file name length
  buf.writeUInt16LE(0, 32);                 // file comment length
  buf.writeUInt16LE(0, 34);                 // disk number where file starts
  buf.writeUInt16LE(0, 36);                 // internal file attributes
  buf.writeUInt32LE(0, 38);                 // external file attributes

  filenameBuffer.copy(buf, 46);             // file name

  if (self.zip64) {
    buf.writeUInt32LE(0xFFFFFFFF, 20);      // compressed size
    buf.writeUInt32LE(0xFFFFFFFF, 24);      // uncompressed size
    buf.writeUInt32LE(0xFFFFFFFF, 42);      // relative offset

    var extraSize = 24;                     // original/compressed + relative offset
    var offset = filenameLength + 46;       // position of extra fields

    buf.writeUInt16LE(extraSize + 4, 30);   // extra field length
    buf.writeUInt16LE(1, offset);           // extra field id (ZIP64)
    buf.writeUInt16LE(extraSize, offset + 2); // extra field size w/o header

    buf.writeUInt32LE(file.uncompressed >>> 0, offset + 4);
    buf.writeUInt32LE(file.uncompressed / MAX_32BIT >>> 0, offset + 8);
    buf.writeUInt32LE(file.compressed >>> 0, offset + 12);
    buf.writeUInt32LE(file.compressed / MAX_32BIT >>> 0, offset + 16);
    buf.writeUInt32LE(file.offset >>> 0, offset + 20);
    buf.writeUInt32LE(file.offset / MAX_32BIT >>> 0, offset + 24);
  } else {
    buf.writeUInt32LE(file.compressed, 20);   // compressed  size
    buf.writeUInt32LE(file.uncompressed, 24); // uncompressed size
    buf.writeUInt16LE(0, 30);                 // extra field length
    buf.writeUInt32LE(file.offset, 42);       // relative offset
  }

  self._write(buf);
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

  self._write(buf);
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

  self._write(buf);
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

  self._write(buf);
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
