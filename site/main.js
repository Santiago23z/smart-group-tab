// Ronda — the site. No scroll listeners: observers decide, CSS moves.

// Depth for the parallax, read once from the markup.
for (const el of document.querySelectorAll('[data-depth]')) {
  el.style.setProperty('--depth', el.dataset.depth);
}

// Entries: each element fades up once, the first time it comes into view.
const reveal = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    reveal.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
for (const el of document.querySelectorAll('.reveal')) reveal.observe(el);

// How it works: the step crossing the middle of the screen picks the phone's screen.
const device = document.querySelector('.sticky-device');
const steps = [...document.querySelectorAll('.step')];
const stepWatch = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    for (const s of steps) s.classList.toggle('on', s === e.target);
    if (device) device.dataset.step = e.target.dataset.step;
  }
}, { rootMargin: '-45% 0px -45% 0px' });
for (const s of steps) stepWatch.observe(s);
steps[0]?.classList.add('on');

// Phone menu.
const root = document.documentElement;
const burger = document.querySelector('.burger');
const menu = document.getElementById('menu');
function setMenu(open) {
  root.classList.toggle('menu-open', open);
  burger.setAttribute('aria-expanded', String(open));
  burger.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
  menu.setAttribute('aria-hidden', String(!open));
}
burger.addEventListener('click', () => setMenu(!root.classList.contains('menu-open')));
menu.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
