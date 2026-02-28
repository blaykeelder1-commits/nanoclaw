/**
 * Sheridan Rentals Chat Widget — NanoClaw Edition
 * Embed on any website with:
 * <script src="https://chat.sheridantrailerrentals.us/widget/chat-widget.js" data-server="https://chat.sheridantrailerrentals.us"></script>
 */
(function() {
  'use strict';

  var SCRIPT = document.currentScript;
  var SERVER_URL = (SCRIPT && SCRIPT.getAttribute('data-server')) || window.SR_CHAT_SERVER || 'https://chat.sheridantrailerrentals.us';

  // Generate or restore visitor ID for session persistence
  var VISITOR_ID = null;
  try {
    VISITOR_ID = sessionStorage.getItem('sr_visitor_id');
  } catch (e) { /* private browsing */ }

  // ── Language i18n ───────────────────────────────────────────────
  var STRINGS = {
    en: {
      title: 'Sheridan Rentals',
      subtitle: 'We typically reply instantly',
      placeholder: 'Type a message...',
      closeLabel: 'Close chat'
    },
    es: {
      title: 'Sheridan Rentals',
      subtitle: 'Respondemos al instante',
      placeholder: 'Escribe un mensaje...',
      closeLabel: 'Cerrar chat'
    }
  };

  var currentLang = 'en';
  try {
    var saved = sessionStorage.getItem('sr_chat_lang');
    if (saved === 'es') currentLang = 'es';
  } catch (e) {}

  // Load Socket.IO client
  function loadSocketIO(callback) {
    if (window.io) return callback();
    var script = document.createElement('script');
    script.src = SERVER_URL + '/socket.io/socket.io.js';
    script.onload = callback;
    script.onerror = function() { console.error('[SheridanChat] Failed to load Socket.IO'); };
    document.head.appendChild(script);
  }

  // Load CSS
  function loadCSS() {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = SERVER_URL + '/widget/chat-widget.css';
    document.head.appendChild(link);
  }

  // Build widget HTML
  function buildWidget() {
    var s = STRINGS[currentLang];
    var container = document.createElement('div');
    container.id = 'sr-chat-widget';
    container.innerHTML =
      '<div id="sr-chat-window">' +
        '<div id="sr-chat-header">' +
          '<div>' +
            '<h3 id="sr-header-title">' + s.title + '</h3>' +
            '<p id="sr-header-subtitle">' + s.subtitle + '</p>' +
          '</div>' +
          '<div class="sr-header-actions">' +
            '<div id="sr-lang-toggle" class="sr-lang-toggle">' +
              '<button class="sr-lang-btn' + (currentLang === 'en' ? ' active' : '') + '" data-lang="en">EN</button>' +
              '<button class="sr-lang-btn' + (currentLang === 'es' ? ' active' : '') + '" data-lang="es">ES</button>' +
            '</div>' +
            '<button id="sr-chat-close" aria-label="' + s.closeLabel + '">' +
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '<line x1="18" y1="6" x2="6" y2="18"></line>' +
                '<line x1="6" y1="6" x2="18" y2="18"></line>' +
              '</svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div id="sr-chat-messages">' +
          '<div class="sr-typing" id="sr-typing">' +
            '<div class="sr-typing-dot"></div>' +
            '<div class="sr-typing-dot"></div>' +
            '<div class="sr-typing-dot"></div>' +
          '</div>' +
        '</div>' +
        '<div id="sr-chat-input-area">' +
          '<input type="text" id="sr-chat-input" placeholder="' + s.placeholder + '" autocomplete="off">' +
          '<button id="sr-chat-send" aria-label="Send message">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">' +
              '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>' +
            '</svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<button id="sr-chat-bubble" aria-label="Open chat">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>' +
        '</svg>' +
      '</button>';
    document.body.appendChild(container);
    return container;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function setLanguage(lang) {
    currentLang = lang;
    try { sessionStorage.setItem('sr_chat_lang', lang); } catch (e) {}

    var s = STRINGS[lang];
    var titleEl = document.getElementById('sr-header-title');
    var subtitleEl = document.getElementById('sr-header-subtitle');
    var inputEl = document.getElementById('sr-chat-input');
    if (titleEl) titleEl.textContent = s.title;
    if (subtitleEl) subtitleEl.textContent = s.subtitle;
    if (inputEl) inputEl.placeholder = s.placeholder;

    // Update toggle button active states
    var btns = document.querySelectorAll('#sr-lang-toggle .sr-lang-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-lang') === lang);
    }

    // Dispatch event so booking form can sync
    try { window.dispatchEvent(new CustomEvent('sr-lang-change', { detail: { lang: lang } })); } catch (e) {}
  }

  function init() {
    loadCSS();

    var widget = buildWidget();
    var bubble = document.getElementById('sr-chat-bubble');
    var chatWindow = document.getElementById('sr-chat-window');
    var closeBtn = document.getElementById('sr-chat-close');
    var messagesEl = document.getElementById('sr-chat-messages');
    var inputEl = document.getElementById('sr-chat-input');
    var sendBtn = document.getElementById('sr-chat-send');
    var typingEl = document.getElementById('sr-typing');

    var socket = null;
    var isOpen = false;
    var connected = false;
    var typingTimeout = null;

    // Language toggle click handler
    var langToggle = document.getElementById('sr-lang-toggle');
    langToggle.addEventListener('click', function(e) {
      var btn = e.target.closest('.sr-lang-btn');
      if (!btn) return;
      setLanguage(btn.getAttribute('data-lang'));
    });

    // Toggle chat open/close
    bubble.addEventListener('click', function() {
      isOpen = !isOpen;
      chatWindow.classList.toggle('sr-open', isOpen);
      bubble.style.display = isOpen ? 'none' : 'flex';
      if (isOpen && !connected) {
        connectSocket();
      }
      if (isOpen) {
        inputEl.focus();
        scrollToBottom();
      }
    });

    closeBtn.addEventListener('click', function() {
      isOpen = false;
      chatWindow.classList.remove('sr-open');
      bubble.style.display = 'flex';
    });

    // Send message
    function sendMessage(text) {
      if (!text.trim() || !socket) return;
      addMessage('user', text);
      // Prepend [SPANISH] tag if in Spanish mode
      var outText = currentLang === 'es' ? '[SPANISH] ' + text : text;
      socket.emit('message', { text: outText });
      inputEl.value = '';
    }

    sendBtn.addEventListener('click', function() {
      sendMessage(inputEl.value);
    });

    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value);
      }
    });

    // Render a price breakdown card
    function renderPriceBreakdown(breakdown) {
      var card = document.createElement('div');
      card.className = 'sr-price-card';

      var title = document.createElement('div');
      title.className = 'sr-price-title';
      title.textContent = breakdown.title || 'Price Breakdown';
      card.appendChild(title);

      // Line items
      if (breakdown.items && breakdown.items.length > 0) {
        breakdown.items.forEach(function(item) {
          var row = document.createElement('div');
          row.className = 'sr-price-row';
          row.innerHTML = '<span>' + escapeHtml(item.label) + '</span><span>' + escapeHtml(item.amount) + '</span>';
          card.appendChild(row);
        });
      }

      // Divider
      var divider = document.createElement('div');
      divider.className = 'sr-price-divider';
      card.appendChild(divider);

      // Total
      var totalRow = document.createElement('div');
      totalRow.className = 'sr-price-row sr-price-total';
      totalRow.innerHTML = '<span>Total</span><span>' + escapeHtml(breakdown.total) + '</span>';
      card.appendChild(totalRow);

      // Deposit line
      if (breakdown.deposit) {
        var depRow = document.createElement('div');
        depRow.className = 'sr-price-row sr-price-deposit';
        depRow.innerHTML = '<span>Deposit (due now)</span><span>' + escapeHtml(breakdown.deposit) + '</span>';
        card.appendChild(depRow);

        var balRow = document.createElement('div');
        balRow.className = 'sr-price-row sr-price-balance';
        balRow.innerHTML = '<span>Balance (due at pickup)</span><span>' + escapeHtml(breakdown.balance) + '</span>';
        card.appendChild(balRow);
      }

      return card;
    }

    // Add message to chat
    function addMessage(sender, content, metadata) {
      var msg = document.createElement('div');
      msg.className = 'sr-message sr-message-' + (sender === 'user' ? 'user' : 'bot');
      msg.textContent = content;
      messagesEl.insertBefore(msg, typingEl);

      // Add price breakdown card if present
      if (metadata && metadata.priceBreakdown) {
        var priceCard = renderPriceBreakdown(metadata.priceBreakdown);
        messagesEl.insertBefore(priceCard, typingEl);
      }

      // Add buttons if present
      if (metadata && metadata.buttons && metadata.buttons.length > 0) {
        var btnsDiv = document.createElement('div');
        btnsDiv.className = 'sr-buttons';
        metadata.buttons.forEach(function(btn) {
          var button = document.createElement('button');
          button.className = 'sr-btn';
          button.textContent = btn.label;
          button.addEventListener('click', function() {
            sendMessage(btn.value);
            btnsDiv.remove();
          });
          btnsDiv.appendChild(button);
        });
        messagesEl.insertBefore(btnsDiv, typingEl);
      }

      // Add payment link if present
      if (metadata && metadata.paymentLink) {
        var linkEl = document.createElement('a');
        linkEl.className = 'sr-payment-btn';
        linkEl.href = metadata.paymentLink;
        linkEl.target = '_blank';
        linkEl.rel = 'noopener noreferrer';
        linkEl.textContent = metadata.paymentLabel || 'Complete Payment';
        messagesEl.insertBefore(linkEl, typingEl);
      }

      scrollToBottom();
    }

    function scrollToBottom() {
      setTimeout(function() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 50);
    }

    // Connect to WebSocket
    function connectSocket() {
      loadSocketIO(function() {
        var connectOpts = {
          transports: ['websocket', 'polling'],
          auth: {}
        };

        // Send visitor ID if we have one (for reconnection)
        if (VISITOR_ID) {
          connectOpts.auth.visitorId = VISITOR_ID;
        }

        socket = window.io(SERVER_URL, connectOpts);

        socket.on('connect', function() {
          connected = true;
          console.log('[SheridanChat] Connected');
        });

        // Receive session info (visitor ID)
        socket.on('session', function(data) {
          if (data && data.visitorId) {
            VISITOR_ID = data.visitorId;
            try {
              sessionStorage.setItem('sr_visitor_id', data.visitorId);
            } catch (e) { /* private browsing */ }
          }
        });

        socket.on('message', function(data) {
          // Clear typing indicator
          typingEl.classList.remove('sr-visible');
          if (typingTimeout) {
            clearTimeout(typingTimeout);
            typingTimeout = null;
          }

          addMessage('bot', data.content, {
            buttons: data.buttons,
            paymentLink: data.paymentLink,
            paymentLabel: data.paymentLabel,
            priceBreakdown: data.priceBreakdown
          });
        });

        socket.on('typing', function(isTyping) {
          typingEl.classList.toggle('sr-visible', isTyping);
          if (isTyping) {
            scrollToBottom();
            // Auto-hide typing after 30s (container processing safety net)
            if (typingTimeout) clearTimeout(typingTimeout);
            typingTimeout = setTimeout(function() {
              typingEl.classList.remove('sr-visible');
            }, 30000);
          }
        });

        socket.on('disconnect', function() {
          connected = false;
          console.log('[SheridanChat] Disconnected');
        });

        socket.on('connect_error', function(err) {
          console.error('[SheridanChat] Connection error:', err.message);
        });
      });
    }
  }

  // Init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
