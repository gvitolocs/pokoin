// Pokoin News share controls: copy link and native share. No analytics, no fetch.
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    var buttons = document.querySelectorAll('.nx-share__copy');
    for (var i = 0; i < buttons.length; i += 1) {
      (function (button) {
        var original = button.textContent;
        button.addEventListener('click', function () {
          var url = button.getAttribute('data-url') || window.location.href;
          var copy = navigator.clipboard && navigator.clipboard.writeText
            ? navigator.clipboard.writeText(url)
            : Promise.reject(new Error('no clipboard'));
          copy.then(function () {
            button.textContent = 'Copied';
            window.setTimeout(function () {
              button.textContent = original;
            }, 2000);
          });
        });
      }(buttons[i]));
    }

    if (navigator.share) {
      var share = document.querySelector('.nx-share');
      if (share) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'nx-share__share';
        button.textContent = 'Share';
        button.addEventListener('click', function () {
          navigator.share({ title: document.title, url: window.location.href });
        });
        share.appendChild(button);
      }
    }
  });
}());
