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

// How it works: the section is as tall as the row is wide, so the row slides
// one pixel left for every pixel scrolled. Only when CSS drives the slide.
const how = document.querySelector('.how');
const pin = how.querySelector('.how-pin');
const track = how.querySelector('.how-track');
if (CSS.supports('animation-timeline: view()') && matchMedia('(prefers-reduced-motion: no-preference) and (min-height: 600px)').matches) {
  const size = () => how.style.setProperty('--how-h', `${pin.offsetHeight + track.offsetWidth - pin.clientWidth}px`);
  new ResizeObserver(size).observe(track);
  new ResizeObserver(size).observe(pin);
}

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
