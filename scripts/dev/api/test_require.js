try {
    require('express');
    console.log('express ok');
} catch (e) {
    console.log('express missing');
}
try {
    require('sqlite3');
    console.log('sqlite3 ok');
} catch (e) {
    console.log('sqlite3 missing');
}
