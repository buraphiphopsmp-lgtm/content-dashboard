const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.json')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(PUBLIC));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'content-dashboard.html')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.listen(PORT, '0.0.0.0', () => console.log('Dashboard on ' + PORT));
