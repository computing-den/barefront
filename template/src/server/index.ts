import express from 'express';
import path from 'path';
import { adder } from '../common/adder.js';

const PUBLIC = path.join(process.cwd(), 'public');
const DIST = path.join(process.cwd(), 'dist/bundles');

const app = express();
app.use(express.json());

app.use('/public', express.static(PUBLIC));
app.use('/dist', express.static(DIST));

app.get('/adder', (req, res) => {
  res.send(`2 + 2 = ${adder(2, 2)}`);
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>Template</title>
    <link rel="stylesheet" href="/dist/style.css">
	  <script src="/dist/index.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`);
});

app.listen(3000, () => {
  console.log(`Listening on port 3000`);
});
