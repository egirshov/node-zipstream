
// test for "creating empty archive"

var zipstream = require('../zipstream');
var crypto = require('crypto');

var zip = zipstream.createZip();
zip.on('error', function (message) {
  console.log('Error: ' + message);
});

// finalize zip without adding any files
zip.finalize(function () {
  console.log('ok!');
});
