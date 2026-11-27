'use strict';

const comparison = document.querySelector('.comparison');
const views = comparison.querySelector('.view-controls');
const controls = comparison.querySelector('.overlay-controls');
const slider = controls.querySelector('input');
const buttons = views.querySelectorAll('button');

function updateSplit() {
  comparison.style.setProperty('--split', `${slider.value}%`);
  slider.setAttribute('aria-valuetext', `${slider.value}% before`);
}

views.addEventListener('click', event => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;

  comparison.dataset.mode = button.dataset.view;
  controls.hidden = button.dataset.view !== 'overlay';
  for (const choice of buttons) {
    choice.setAttribute('aria-pressed', String(choice === button));
  }
});

slider.addEventListener('input', updateSplit);
updateSplit();
views.hidden = false;
