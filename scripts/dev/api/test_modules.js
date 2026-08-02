console.log('Testing requires...');
try {
    console.log('Requiring express...');
    require('express');
    console.log('Requiring jimp...');
    require('jimp');
    console.log('Requiring sqlite3...');
    require('sqlite3');
    console.log('All modules required successfully!');
} catch (e) {
    console.error('Error requiring module:', e);
}
