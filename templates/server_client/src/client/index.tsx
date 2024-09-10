import { createRoot } from 'react-dom/client';
import React from 'react';

function setup() {
  const root = createRoot(document.getElementById('app')!);
  root.render(
    <>
      <img src="/barefront.svg" />
      <h1>Hello Barefront!</h1>
    </>,
  );
}

window.onload = setup;
