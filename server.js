const express = require('express');
const app = express()
const port = 3000;
const path = require('path');

const {handleSSE} = require('./index');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.send('OK');
})

// SSE stream endpoint
app.get('/events', handleSSE);

// Simple client page that connects to SSE stream and shows last 10 lines
app.get('/log', (req, res) => {
    res.set('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, 'public', 'log.html'));
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})