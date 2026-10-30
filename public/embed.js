/*
 * Embed the booking page in any website (e.g. an Elementor "HTML" widget):
 *
 *   <div id="bahia-booking"></div>
 *   <script src="https://book.YOUR-DOMAIN.com/embed.js" data-target="bahia-booking" async></script>
 *
 * Optional attributes: data-offset="80" (height of your sticky site header, used
 * when scrolling to the next step), data-min-height="760".
 */
(function () {
  var script = document.currentScript;
  if (!script || !script.src) return;
  var origin = new URL(script.src).origin;
  var targetId = script.getAttribute('data-target');
  var box = targetId && document.getElementById(targetId);
  if (!box) {
    box = document.createElement('div');
    script.parentNode.insertBefore(box, script);
  }
  var frame = document.createElement('iframe');
  var query = new URLSearchParams(window.location.search);
  frame.src = origin + '/?embed=1' + (query.get('date') ? '&date=' + encodeURIComponent(query.get('date')) : '');
  frame.title = script.getAttribute('data-title') || 'Book tickets';
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('allow', 'payment');
  frame.style.cssText = 'display:block;width:100%;border:0;overflow:hidden;min-height:' + (parseInt(script.getAttribute('data-min-height'), 10) || 760) + 'px;';
  box.appendChild(frame);

  var offset = parseInt(script.getAttribute('data-offset'), 10) || 80;
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || e.data.source !== 'bp-booking') return;
    if (e.data.type === 'height' && e.data.height > 0) {
      frame.style.minHeight = '0';
      frame.style.height = e.data.height + 'px';
    } else if (e.data.type === 'scroll') {
      var top = frame.getBoundingClientRect().top + window.pageYOffset + (e.data.top || 0) - offset;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  });
})();
