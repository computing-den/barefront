import 'dotenv/config';

import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { adder } from '../common/adder.js';

const PUBLIC = path.join(process.cwd(), 'public');
const DIST_PUBLIC = path.join(process.cwd(), 'dist/public');

const app = express();

// Trust the reverse proxy on the same server so that req.ip will be taken from X-Forwarded-For header.
// See https://expressjs.com/en/guide/behind-proxies.html
app.set('trust proxy', 'loopback');

app.use(express.json());

app.use('/', express.static(PUBLIC));
app.use('/', express.static(DIST_PUBLIC));

app.use(cookieParser());

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
    <meta name="description" content="%{name} description goes here">
    <title>%{name}</title>
    <link rel="stylesheet" href="/style.css">
	  <script src="/index.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`);
});

app.use((req, res, next) => {
  res.status(404).send('Page not found.');
});

app.use(((error, req, res, next) => {
  console.error(error);
  res.status(500).send(error.message);
}) as express.ErrorRequestHandler);

app.listen(Number(process.env.PORT), () => {
  console.log(`Listening on port ${process.env.PORT}`);
});
