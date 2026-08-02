try {
    const express = require('express');
    console.log('Express loaded');
} catch (e) {
    console.error('Express failed to load:', e.message);
}
