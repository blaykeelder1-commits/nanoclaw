/**
 * Snak Group Chat Widget
 * Client-side FAQ bot with live escalation to Andy via Socket.IO.
 *
 * Usage: <script src="https://YOUR_SERVER:3200/snakgroup-chat-widget.js"></script>
 *
 * FAQ mode: instant client-side responses, zero API cost.
 * Live mode: connects to NanoClaw web channel when buying intent detected.
 */
(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────
  const CONFIG = {
    serverUrl: (function () {
      var s = document.currentScript && document.currentScript.src;
      if (s) {
        try {
          var u = new URL(s);
          return u.origin;
        } catch (e) {}
      }
      return 'https://212.28.179.31:3200';
    })(),
    business: 'snak-group',
    title: 'Chat with Snak Group',
    greeting:
      "Hey there! I'm Andy from Snak Group. How can I help you today?",
    escalationThreshold: 2, // consecutive unmatched messages before escalation
  };

  // ── FAQ Knowledge Base ─────────────────────────────────────────
  var FAQ = [
    {
      keywords: [
        'cost',
        'price',
        'pricing',
        'how much',
        'charge',
        'fee',
        'pay',
        'expensive',
        'free',
        'money',
      ],
      answer:
        "Great news — everything is completely free to your location! We handle the machine, installation, stocking, maintenance, and monitoring at zero cost to you. Pricing for specific setups depends on the location, but we're extremely competitive. Want me to get you a custom quote?",
      suggestions: ['Get a quote', 'What machines do you offer?'],
    },
    {
      keywords: [
        'machine',
        'vending',
        'what do you offer',
        'what kind',
        'options',
        'types',
        'equipment',
        'products',
      ],
      answer:
        "We offer a few different options:\n\n- Smart Store 700 vending machines (single and double door) — snacks, drinks, and more\n- Vitro X1 countertop coffee machines — 12 amazing coffee options\n- Ice machines\n- Smart coolers\n\nAll fully stocked and maintained by us. Which one sounds like it might be a fit?",
      suggestions: ['Tell me about coffee', 'Is there a cost?'],
    },
    {
      keywords: [
        'coffee',
        'vitro',
        'espresso',
        'latte',
        'cappuccino',
        'hot drink',
        'brew',
      ],
      answer:
        "Our Vitro X1 countertop coffee machine is a game-changer — 12 different coffee options including espresso, latte, cappuccino, and more. It's compact, fully automated, and we handle all the restocking and maintenance. Perfect for offices, hotels, and hospitals. Interested?",
      suggestions: ['Is there a cost?', 'How does setup work?'],
    },
    {
      keywords: [
        'restock',
        'refill',
        'stock',
        'empty',
        'run out',
        'supply',
        'snack',
        'drink',
        'product',
        'selection',
      ],
      answer:
        "We handle all restocking — you never have to worry about it! We monitor machine inventory and restock regularly. Plus, every month your team gets to vote on new products through our customer app by scanning a QR code on the machine. Customer service is our top priority.",
      suggestions: ['Tell me about the app', 'What machines do you offer?'],
    },
    {
      keywords: [
        'app',
        'qr',
        'vote',
        'scan',
        'customer app',
        'poll',
        'choose',
        'pick products',
      ],
      answer:
        "Every month, customers scan a QR code on the machine to swipe through new product options, see pictures, and vote on what they want stocked. It keeps the selection fresh and tailored to your team's preferences!",
      suggestions: ['How does setup work?', 'Is there a cost?'],
    },
    {
      keywords: [
        'space',
        'room',
        'size',
        'dimensions',
        'fit',
        'where',
        'footprint',
        'breakroom',
        'break room',
      ],
      answer:
        "Our Smart Store 700 vending machines need about 3ft x 3ft of floor space. The Vitro X1 coffee machine is a countertop unit — just needs a flat surface and a power outlet. We'll do a site visit to figure out the best spot. Want to set that up?",
      suggestions: ['Get a quote', 'How does setup work?'],
    },
    {
      keywords: [
        'area',
        'service',
        'location',
        'houston',
        'texas',
        'serve',
        'where do you',
        'coverage',
      ],
      answer:
        "We serve the entire Houston, TX metro area. We've got 50+ happy locations across the city! Is your business in the Houston area?",
      suggestions: ['Get a quote', 'What machines do you offer?'],
    },
    {
      keywords: [
        'setup',
        'install',
        'installation',
        'timeline',
        'how long',
        'get started',
        'start',
        'process',
        'next step',
      ],
      answer:
        "The process is simple:\n1. We chat to see if it's a good fit\n2. Quick site visit to check the space\n3. We handle delivery, installation, and setup\n\nWe take care of everything — you just need to point us to the spot! Want to get the ball rolling?",
      suggestions: ['Get a quote', 'Is there a cost?'],
    },
    {
      keywords: [
        'payment',
        'card',
        'cash',
        'accept',
        'apple pay',
        'tap',
        'swipe',
        'contactless',
      ],
      answer:
        "Our Smart Store 700 machines accept credit/debit cards, Apple Pay, Google Pay, and contactless payments. Super convenient for everyone!",
      suggestions: ['What machines do you offer?', 'How does setup work?'],
    },
    {
      keywords: [
        'maintenance',
        'repair',
        'broken',
        'fix',
        'service',
        'support',
        'issue',
        'problem',
      ],
      answer:
        "We handle all maintenance and repairs — it's all included at no cost to you. If a machine ever has an issue, we monitor it remotely and get it fixed fast. You'll never have to worry about a thing.",
      suggestions: ['Is there a cost?', 'What machines do you offer?'],
    },
    {
      keywords: [
        'revenue',
        'commission',
        'split',
        'share',
        'earn',
        'profit',
        'income',
        'make money',
      ],
      answer:
        "Revenue sharing details depend on the specific location and setup. We always make sure it's a win-win arrangement. Want me to connect you with our team to discuss the specifics for your location?",
      suggestions: ['Get a quote', 'How does setup work?'],
    },
    {
      keywords: [
        'who',
        'about',
        'company',
        'snak group',
        'snak',
        'what is',
        'tell me about',
      ],
      answer:
        "We're Snak Group — we place and maintain vending machines, coffee machines, and ice machines at businesses across Houston, TX. We've got 50+ happy locations and counting! Our values: Smart, Negotiable, Active, Kind. Everything is free to the location — we handle it all.",
      suggestions: ['What machines do you offer?', 'Is there a cost?'],
    },
    {
      keywords: [
        'foot traffic',
        'people',
        'employees',
        'staff',
        'visitors',
        'requirements',
        'minimum',
        'qualify',
      ],
      answer:
        "For a vending machine placement to work well, we generally look for locations with 50+ people passing through daily. That could be employees, students, patients, gym members — any steady foot traffic. What kind of location are you thinking about?",
      suggestions: ['Get a quote', 'What machines do you offer?'],
    },
    {
      keywords: ['hello', 'hi', 'hey', 'howdy', 'sup', 'yo', 'good morning', 'good afternoon'],
      answer:
        "Hey! Welcome to Snak Group. We place free vending machines, coffee machines, and ice machines at businesses across Houston. What can I help you with?",
      suggestions: [
        'What machines do you offer?',
        'Is there a cost?',
        'Get a quote',
      ],
    },
  ];

  // ── Escalation Detection ───────────────────────────────────────
  var BUYING_INTENT_PATTERNS = [
    /\b(quote|proposal|estimate)\b/i,
    /\b(interested|sign up|sign me up|get started|let'?s do it|ready)\b/i,
    /\b(schedule|appointment|meeting|call|visit)\b/i,
    /\b(my business|my office|our office|my location|our location|my building|our building)\b/i,
    /\b(my company|our company|my school|our school|my gym|our gym)\b/i,
    /\b(how (soon|fast)|when can|asap)\b/i,
    /\b(contact|reach|phone|email me|call me)\b/i,
  ];

  var CONTACT_INFO_PATTERN =
    /(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b)/i;

  function detectBuyingIntent(text) {
    for (var i = 0; i < BUYING_INTENT_PATTERNS.length; i++) {
      if (BUYING_INTENT_PATTERNS[i].test(text)) return true;
    }
    return CONTACT_INFO_PATTERN.test(text);
  }

  function matchFAQ(text) {
    var lower = text.toLowerCase();
    var bestMatch = null;
    var bestScore = 0;

    for (var i = 0; i < FAQ.length; i++) {
      var faq = FAQ[i];
      var score = 0;
      for (var j = 0; j < faq.keywords.length; j++) {
        if (lower.indexOf(faq.keywords[j]) !== -1) {
          score += faq.keywords[j].length; // longer keyword matches score higher
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = faq;
      }
    }

    return bestScore >= 3 ? bestMatch : null;
  }

  // ── Widget State ───────────────────────────────────────────────
  var state = {
    isOpen: false,
    isLive: false,
    socket: null,
    sessionId: null,
    messages: [],
    unmatchedCount: 0,
    conversationHistory: [],
  };

  // ── Load CSS ───────────────────────────────────────────────────
  function loadCSS() {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CONFIG.serverUrl + '/snakgroup-chat-widget.css';
    document.head.appendChild(link);
  }

  // ── Load Socket.IO client ─────────────────────────────────────
  function loadSocketIO(callback) {
    if (window.io) {
      callback();
      return;
    }
    var script = document.createElement('script');
    script.src = CONFIG.serverUrl + '/socket.io/socket.io.js';
    script.onload = callback;
    script.onerror = function () {
      console.error('Failed to load Socket.IO client');
    };
    document.head.appendChild(script);
  }

  // ── Build UI ───────────────────────────────────────────────────
  function buildWidget() {
    // Container
    var container = document.createElement('div');
    container.id = 'snak-chat-widget';
    container.innerHTML =
      '<div id="snak-chat-bubble" aria-label="Open chat">' +
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="white">' +
      '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>' +
      '</svg>' +
      '</div>' +
      '<div id="snak-chat-window" class="snak-hidden">' +
      '<div id="snak-chat-header">' +
      '<div id="snak-chat-header-info">' +
      '<div id="snak-chat-header-title">' +
      CONFIG.title +
      '</div>' +
      '<div id="snak-chat-header-status">Online</div>' +
      '</div>' +
      '<button id="snak-chat-close" aria-label="Close chat">&times;</button>' +
      '</div>' +
      '<div id="snak-chat-messages"></div>' +
      '<div id="snak-chat-suggestions"></div>' +
      '<div id="snak-chat-input-area">' +
      '<input id="snak-chat-input" type="text" placeholder="Type a message..." autocomplete="off" />' +
      '<button id="snak-chat-send" aria-label="Send message">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
      '</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(container);

    // Event listeners
    document
      .getElementById('snak-chat-bubble')
      .addEventListener('click', toggleChat);
    document
      .getElementById('snak-chat-close')
      .addEventListener('click', toggleChat);
    document
      .getElementById('snak-chat-send')
      .addEventListener('click', sendMessage);
    document
      .getElementById('snak-chat-input')
      .addEventListener('keydown', function (e) {
        if (e.key === 'Enter') sendMessage();
      });
  }

  function toggleChat() {
    state.isOpen = !state.isOpen;
    var window = document.getElementById('snak-chat-window');
    var bubble = document.getElementById('snak-chat-bubble');

    if (state.isOpen) {
      window.classList.remove('snak-hidden');
      bubble.classList.add('snak-hidden');
      document.getElementById('snak-chat-input').focus();

      // Show greeting on first open
      if (state.messages.length === 0) {
        addBotMessage(CONFIG.greeting);
        showSuggestions([
          'What machines do you offer?',
          'Is there a cost?',
          'Get a quote',
        ]);
      }
    } else {
      window.classList.add('snak-hidden');
      bubble.classList.remove('snak-hidden');
    }
  }

  // ── Message Display ────────────────────────────────────────────
  function addBotMessage(text) {
    state.messages.push({ sender: 'bot', text: text });
    state.conversationHistory.push({ role: 'assistant', text: text });

    var messagesEl = document.getElementById('snak-chat-messages');
    var msgEl = document.createElement('div');
    msgEl.className = 'snak-msg snak-msg-bot';

    // Convert newlines to <br>
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) msgEl.appendChild(document.createElement('br'));
      msgEl.appendChild(document.createTextNode(lines[i]));
    }

    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addUserMessage(text) {
    state.messages.push({ sender: 'user', text: text });
    state.conversationHistory.push({ role: 'user', text: text });

    var messagesEl = document.getElementById('snak-chat-messages');
    var msgEl = document.createElement('div');
    msgEl.className = 'snak-msg snak-msg-user';
    msgEl.textContent = text;
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addSystemMessage(text) {
    var messagesEl = document.getElementById('snak-chat-messages');
    var msgEl = document.createElement('div');
    msgEl.className = 'snak-msg snak-msg-system';
    msgEl.textContent = text;
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showSuggestions(suggestions) {
    var suggestionsEl = document.getElementById('snak-chat-suggestions');
    suggestionsEl.innerHTML = '';

    if (!suggestions || suggestions.length === 0) return;

    // Always add "Talk to Andy" if not in live mode
    var allSuggestions = suggestions.slice();
    if (!state.isLive) {
      allSuggestions.push('Talk to Andy');
    }

    for (var i = 0; i < allSuggestions.length; i++) {
      var btn = document.createElement('button');
      btn.className = 'snak-suggestion-btn';
      btn.textContent = allSuggestions[i];
      btn.addEventListener(
        'click',
        (function (text) {
          return function () {
            document.getElementById('snak-chat-input').value = text;
            sendMessage();
          };
        })(allSuggestions[i])
      );
      suggestionsEl.appendChild(btn);
    }
  }

  function showTypingIndicator() {
    var messagesEl = document.getElementById('snak-chat-messages');
    // Remove existing typing indicator
    var existing = document.getElementById('snak-typing');
    if (existing) existing.remove();

    var typingEl = document.createElement('div');
    typingEl.id = 'snak-typing';
    typingEl.className = 'snak-msg snak-msg-bot snak-typing';
    typingEl.innerHTML =
      '<span class="snak-dot"></span><span class="snak-dot"></span><span class="snak-dot"></span>';
    messagesEl.appendChild(typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTypingIndicator() {
    var existing = document.getElementById('snak-typing');
    if (existing) existing.remove();
  }

  // ── Message Handling ───────────────────────────────────────────
  function sendMessage() {
    var input = document.getElementById('snak-chat-input');
    var text = input.value.trim();
    if (!text) return;

    input.value = '';
    addUserMessage(text);

    // Clear suggestions
    document.getElementById('snak-chat-suggestions').innerHTML = '';

    if (state.isLive) {
      sendLiveMessage(text);
      return;
    }

    // Check for "Talk to Andy" button
    if (text.toLowerCase() === 'talk to andy') {
      escalateToLive('Customer requested live chat');
      return;
    }

    // Check for buying intent
    if (detectBuyingIntent(text)) {
      escalateToLive('Buying intent detected');
      return;
    }

    // Try FAQ match
    var match = matchFAQ(text);
    if (match) {
      state.unmatchedCount = 0;
      // Small delay to feel natural
      setTimeout(function () {
        addBotMessage(match.answer);
        showSuggestions(match.suggestions || []);
      }, 400);
    } else {
      state.unmatchedCount++;
      if (state.unmatchedCount >= CONFIG.escalationThreshold) {
        escalateToLive(
          'Multiple unmatched questions'
        );
      } else {
        setTimeout(function () {
          addBotMessage(
            "I'm not sure I have the answer to that one. Feel free to ask about our machines, pricing, setup process, or anything else — or I can connect you with our team!"
          );
          showSuggestions(['Talk to Andy', 'What machines do you offer?']);
        }, 400);
      }
    }
  }

  // ── Live Mode (Socket.IO) ─────────────────────────────────────
  function escalateToLive(reason) {
    state.isLive = true;
    state.unmatchedCount = 0;

    // Update header
    document.getElementById('snak-chat-header-status').textContent =
      'Connecting to Andy...';

    addSystemMessage("Connecting you with Andy from our team...");
    showSuggestions([]);

    loadSocketIO(function () {
      connectSocket(reason);
    });
  }

  function connectSocket(reason) {
    var socket = window.io(CONFIG.serverUrl, {
      query: {
        business: CONFIG.business,
        sessionId: state.sessionId || undefined,
      },
      transports: ['websocket', 'polling'],
    });

    state.socket = socket;

    socket.on('session', function (data) {
      state.sessionId = data.sessionId;
    });

    socket.on('connect', function () {
      document.getElementById('snak-chat-header-status').textContent =
        'Connected to Andy';

      // Build FAQ history summary for context
      var history = '';
      for (var i = 0; i < state.conversationHistory.length; i++) {
        var msg = state.conversationHistory[i];
        var prefix = msg.role === 'user' ? 'Customer' : 'FAQ Bot';
        history += prefix + ': ' + msg.text + '\n';
      }

      // Send the last user message (the one that triggered escalation)
      var lastUserMsg = '';
      for (var j = state.conversationHistory.length - 1; j >= 0; j--) {
        if (state.conversationHistory[j].role === 'user') {
          lastUserMsg = state.conversationHistory[j].text;
          break;
        }
      }

      socket.emit('message', {
        text: lastUserMsg || 'Customer wants to chat',
        history: history,
      });
    });

    socket.on('message', function (data) {
      hideTypingIndicator();
      if (data && data.text) {
        addBotMessage(data.text);
      }
    });

    socket.on('typing', function (data) {
      if (data && data.isTyping) {
        showTypingIndicator();
      } else {
        hideTypingIndicator();
      }
    });

    socket.on('disconnect', function () {
      document.getElementById('snak-chat-header-status').textContent =
        'Reconnecting...';
    });

    socket.on('connect_error', function () {
      document.getElementById('snak-chat-header-status').textContent =
        'Connection issue — retrying...';
    });
  }

  function sendLiveMessage(text) {
    if (state.socket && state.socket.connected) {
      state.socket.emit('message', { text: text });
    } else {
      addSystemMessage(
        'Connection lost. Trying to reconnect...'
      );
    }
  }

  // ── Initialize ─────────────────────────────────────────────────
  function init() {
    loadCSS();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildWidget);
    } else {
      buildWidget();
    }
  }

  init();
})();
