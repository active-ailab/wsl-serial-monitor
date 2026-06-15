try {
        const vscode = acquireVsCodeApi();
    const persistedState = window.__persistedUiState || vscode.getState() || {};
        // IMPORTANT: Fire ready IMMEDIATELY so host knows this script is alive.
        // Must be before any complex logic that could throw.
        vscode.postMessage({ command: 'ready' });
        vscode.postMessage({ command: 'requestStatus' });

        const logContent = document.getElementById('logContent');
        const logContainer = document.getElementById('logContainer');
        const welcome = document.getElementById('welcome');
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const btnConnect = document.getElementById('btnConnect');
        const btnDisconnect = document.getElementById('btnDisconnect');
        const btnPause = document.getElementById('btnPause');
        const btnAutoScroll = document.getElementById('btnAutoScroll');
        const pausedIndicator = document.getElementById('pausedIndicator');
        const inputBar = document.getElementById('inputBar');
        const quickCommandEditor = document.getElementById('quickCommandEditor');
        const quickCommandInput = document.getElementById('quickCommandInput');
        const quickCommandList = document.getElementById('quickCommandList');
        const searchInput = document.getElementById('searchInput');
        const searchCountEl = document.getElementById('searchCount');
        const filterCountEl = document.getElementById('filterCount');
        const dataCounterEl = document.getElementById('dataCounter');

        let autoScroll = true;
        let paused = false;
        let lineCount = 0;
        let searchMatches = [];
        let currentSearchIndex = -1;
        let showTimestamp = false;
        let maxBufferBytes = window.__maxBufferBytes || 2097152;
        let displayedBufferBytes = 0;
        let appendNewline = persistedState.appendNewline !== false;
        let quickCommands = Array.isArray(persistedState.quickCommands) ? persistedState.quickCommands : [];
        let quickCommandId = quickCommands.reduce((maxId, item) => {
            return Math.max(maxId, typeof item?.id === 'number' ? item.id : -1);
        }, -1) + 1;
        let userScrolled = false; // Track if user manually scrolled

        // ---- Virtual Scrolling ----
        const VIRTUAL_SCROLL_THRESHOLD = 5000; // Higher threshold for smoother transition
        const LINE_HEIGHT = 20; // Estimated line height in pixels
        const OVERSCAN = 20; // More overscan for smoother scrolling
        let virtualScrollEnabled = false;
        let allLogLines = []; // Store all log line data
        let allLogLineBytes = []; // Store byte sizes for each line
        let renderStartIndex = -1;
        let renderEndIndex = -1;
        let scrollRAF = null; // RequestAnimationFrame ID for scroll handling
        let appendRAF = null; // RAF for batched appends

        // DOM element pool for reuse
        const DOM_POOL_SIZE = 200;
        const domPool = [];
        const activeElements = new Map(); // index -> element

        function getLineByteSize(text) {
            return new TextEncoder().encode(text + '\n').length;
        }

        function getPooledElement() {
            if (domPool.length > 0) {
                return domPool.pop();
            }
            const div = document.createElement('div');
            div.className = 'log-line';
            const tsSpan = document.createElement('span');
            tsSpan.className = 'timestamp';
            const dataSpan = document.createElement('span');
            dataSpan.className = 'data';
            div.appendChild(tsSpan);
            div.appendChild(dataSpan);
            return div;
        }

        function releaseElement(el) {
            if (domPool.length < DOM_POOL_SIZE) {
                // Clear styles
                el.style.display = '';
                const dataSpan = el.querySelector('.data');
                if (dataSpan) {
                    dataSpan.style.color = '';
                    dataSpan.style.background = '';
                    dataSpan.style.borderRadius = '';
                    dataSpan.style.padding = '';
                }
                domPool.push(el);
            }
        }

        // Smart scroll follow: detect if user is at bottom
        const SCROLL_THRESHOLD = 50; // pixels from bottom to consider "at bottom"
        
        function isAtBottom() {
            return logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < SCROLL_THRESHOLD;
        }

        function updateAutoScrollState() {
            const atBottom = isAtBottom();
            if (atBottom && !autoScroll) {
                // User scrolled back to bottom, re-enable auto-scroll
                autoScroll = true;
                userScrolled = false;
                btnAutoScroll.textContent = '⬇ Auto-scroll: ON';
                btnAutoScroll.classList.remove('paused');
            } else if (!atBottom && autoScroll && userScrolled) {
                // User scrolled away from bottom, disable auto-scroll
                autoScroll = false;
                btnAutoScroll.textContent = '⬇ Auto-scroll: OFF';
                btnAutoScroll.classList.add('paused');
            }
        }

        // Listen for manual scroll events
        logContent.addEventListener('scroll', () => {
            userScrolled = true;
            // Debounce the state update
            if (scrollRAF) cancelAnimationFrame(scrollRAF);
            scrollRAF = requestAnimationFrame(() => {
                updateAutoScrollState();
                scrollRAF = null;
            });
        });

        // ---- Filter system ----
        const DEFAULT_FILTER_COLORS = [
            '#4ec9b0', '#569cd6', '#ce9178', '#c586c0',
            '#dcdcaa', '#d7ba7d', '#9cdcfe', '#b5cea8'
        ];
        let filters = [];
        let filterId = 0;
        let filterOnly = Boolean(persistedState.filterOnly);
        let searchRegex = Boolean(persistedState.searchRegex);

        function persistUiState() {
            const state = {
                searchText: searchInput.value,
                searchRegex,
                filterOnly,
                filters,
                showTimestamp: document.getElementById('chkTimestamp')?.checked || false,
                appendNewline,
                quickCommands
            };
            vscode.setState(state);
            vscode.postMessage({ command: 'persistUiState', state });
        }

        function normalizeQuickCommand(item, index) {
            return {
                id: typeof item?.id === 'number' ? item.id : index,
                text: typeof item?.text === 'string' ? item.text : '',
                hex: Boolean(item?.hex),
                appendNewline: item?.appendNewline !== false
            };
        }

        function renderQuickCommands() {
            quickCommandList.innerHTML = '';
            if (quickCommands.length === 0) {
                const empty = document.createElement('span');
                empty.className = 'quick-command-empty';
                empty.textContent = 'No quick commands';
                quickCommandList.appendChild(empty);
                return;
            }

            for (const item of quickCommands) {
                const chip = document.createElement('div');
                chip.className = 'quick-command-chip';

                const sendBtn = document.createElement('button');
                sendBtn.className = 'quick-command-send';
                const flags = [item.hex ? 'HEX' : null, item.appendNewline ? 'CRLF' : null].filter(Boolean).join(', ');
                sendBtn.title = flags ? `${flags}: ${item.text}` : item.text;
                sendBtn.textContent = item.hex ? `[HEX] ${item.text}` : item.text;
                sendBtn.onclick = () => sendQuickCommand(item.id);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'quick-command-remove';
                removeBtn.title = 'Remove quick command';
                removeBtn.textContent = '×';
                removeBtn.onclick = () => removeQuickCommand(item.id);

                chip.appendChild(sendBtn);
                chip.appendChild(removeBtn);
                quickCommandList.appendChild(chip);
            }
        }

        function addQuickCommand() {
            const text = quickCommandInput.value.trim();
            if (!text) {
                quickCommandInput.focus();
                return;
            }

            quickCommands.push({
                id: quickCommandId++,
                text,
                hex: document.getElementById('quickCommandHexMode').checked,
                appendNewline: document.getElementById('quickCommandAppendNewline').checked
            });
            quickCommandInput.value = '';
            document.getElementById('quickCommandHexMode').checked = false;
            document.getElementById('quickCommandAppendNewline').checked = true;
            renderQuickCommands();
            persistUiState();
            toggleQuickCommandEditor(false);
        }

        function removeQuickCommand(id) {
            quickCommands = quickCommands.filter(item => item.id !== id);
            renderQuickCommands();
            persistUiState();
        }

        function sendQuickCommand(id) {
            const item = quickCommands.find(command => command.id === id);
            if (!item) {
                return;
            }
            vscode.postMessage({ command: 'send', text: item.text, hex: item.hex, appendNewline: item.appendNewline });
        }

        function toggleQuickCommandEditor(forceVisible) {
            const shouldShow = typeof forceVisible === 'boolean' ? forceVisible : !quickCommandEditor.classList.contains('visible');
            quickCommandEditor.classList.toggle('visible', shouldShow);
            if (shouldShow) {
                quickCommandInput.focus();
            } else {
                quickCommandInput.value = '';
                document.getElementById('quickCommandHexMode').checked = false;
                document.getElementById('quickCommandAppendNewline').checked = true;
            }
        }

        function toggleFilterMode() {
            filterOnly = document.getElementById('chkFilterOnly').checked;
            applyFiltersToExisting();
            persistUiState();
        }

        function toggleSearchRegex() {
            searchRegex = !searchRegex;
            document.getElementById('btnSearchRegex').classList.toggle('active', searchRegex);
            performSearch();
            persistUiState();
        }

        function addFilter() {
            const id = filterId++;
            const color = DEFAULT_FILTER_COLORS[filters.length % DEFAULT_FILTER_COLORS.length];
            filters.push({ id, text: '', color, enabled: true, regex: false });
            renderFilterEntry(id, color, '', true, false, true);
            applyFiltersToExisting();
            persistUiState();
        }

        function renderFilterEntry(id, color, initialText = '', initialEnabled = true, initialRegex = false, shouldFocus = true) {
            const container = document.getElementById('filterEntries');
            const entry = document.createElement('div');
            entry.className = 'filter-entry';
            entry.id = 'filter-' + id;

            const chk = document.createElement('input');
            chk.type = 'checkbox'; chk.checked = initialEnabled; chk.title = 'Enable/Disable';
            chk.onchange = () => { const f = filters.find(f => f.id === id); if (f) { f.enabled = chk.checked; entry.classList.toggle('disabled', !f.enabled); applyFiltersToExisting(); persistUiState(); } };

            const input = document.createElement('input');
            input.type = 'text'; input.placeholder = 'keyword...'; input.value = initialText;
            input.oninput = () => { const f = filters.find(f => f.id === id); if (f) { f.text = input.value; applyFiltersToExisting(); persistUiState(); } };

            const regexBtn = document.createElement('button');
            regexBtn.className = 'btn-regex';
            regexBtn.textContent = '.*';
            regexBtn.title = 'Regex mode';
            regexBtn.onclick = () => {
                const f = filters.find(f => f.id === id);
                if (f) { f.regex = !f.regex; regexBtn.classList.toggle('active', f.regex); applyFiltersToExisting(); persistUiState(); }
            };
            regexBtn.classList.toggle('active', initialRegex);

            const colorPicker = document.createElement('input');
            colorPicker.type = 'color'; colorPicker.value = color; colorPicker.title = 'Set highlight color';
            colorPicker.oninput = () => { const f = filters.find(f => f.id === id); if (f) { f.color = colorPicker.value; applyFiltersToExisting(); persistUiState(); } };

            const removeBtn = document.createElement('button');
            removeBtn.className = 'filter-remove'; removeBtn.innerHTML = '&times;'; removeBtn.title = 'Remove filter';
            removeBtn.onclick = () => { filters = filters.filter(f => f.id !== id); entry.remove(); applyFiltersToExisting(); persistUiState(); };

            entry.appendChild(chk); entry.appendChild(input); entry.appendChild(regexBtn);
            entry.appendChild(colorPicker); entry.appendChild(removeBtn);
            container.appendChild(entry);
            entry.classList.toggle('disabled', !initialEnabled);
            if (shouldFocus) {
                input.focus();
            }
        }

        function clearFilters() {
            filters = [];
            document.getElementById('filterEntries').innerHTML = '';
            applyFiltersToExisting();
            persistUiState();
        }

        function getActiveFilters() { return filters.filter(f => f.enabled && f.text.trim().length > 0); }

        function matchFilters(text) {
            const active = getActiveFilters();
            if (active.length === 0) return [];
            const matches = [];
            for (const f of active) {
                let hit = false;
                if (f.regex) {
                    try { hit = new RegExp(f.text, 'i').test(text); } catch (e) { /* invalid regex, skip */ }
                } else {
                    hit = text.toLowerCase().includes(f.text.toLowerCase());
                }
                if (hit) matches.push(f);
            }
            return matches;
        }

        function applyFiltersToExisting() {
            const active = getActiveFilters();
            let visibleCount = 0;

            if (virtualScrollEnabled) {
                // Force re-render by resetting cached range
                renderStartIndex = -1;
                renderEndIndex = -1;
                renderVisibleLines();
                visibleCount = filterOnly ? 
                    allLogLines.filter(text => matchFilters(text).length > 0).length : 
                    allLogLines.length;
                filterCountEl.textContent = active.length > 0 ? visibleCount + '/' + allLogLines.length : String(allLogLines.length);
                return;
            }

            const allLines = logContent.querySelectorAll('.log-line');

            for (const line of allLines) {
                const dataSpan = line.querySelector('.data');
                if (!dataSpan) continue;
                const text = dataSpan.textContent || '';

                if (active.length === 0) {
                    line.style.display = ''; dataSpan.style.color = ''; dataSpan.style.background = '';
                    dataSpan.style.borderRadius = ''; dataSpan.style.padding = ''; visibleCount++; continue;
                }

                const matched = matchFilters(text);
                if (matched.length > 0) {
                    line.style.display = ''; dataSpan.style.color = matched[0].color;
                    dataSpan.style.background = hexToRgba(matched[0].color, 0.12);
                    dataSpan.style.borderRadius = '2px'; dataSpan.style.padding = '0 2px'; visibleCount++;
                } else if (filterOnly) {
                    line.style.display = 'none';
                } else {
                    line.style.display = ''; dataSpan.style.color = ''; dataSpan.style.background = '';
                    dataSpan.style.borderRadius = ''; dataSpan.style.padding = ''; visibleCount++;
                }
            }

            filterCountEl.textContent = active.length > 0 ? visibleCount + '/' + allLines.length : String(allLines.length);
        }

        function hexToRgba(hex, alpha) {
            return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' + parseInt(hex.slice(5, 7), 16) + ',' + alpha + ')';
        }

        // ---- Virtual Scrolling Functions ----
        function createLogLineElement(text, lineIndex) {
            const div = document.createElement('div');
            div.className = 'log-line';
            div.setAttribute('data-index', String(lineIndex));
            const lineByteSize = allLogLineBytes[lineIndex] || getLineByteSize(text);
            div.setAttribute('data-bytes', String(lineByteSize));

            if (showTimestamp) {
                const now = new Date();
                const ts = String(now.getHours()).padStart(2, '0') + ':' +
                           String(now.getMinutes()).padStart(2, '0') + ':' +
                           String(now.getSeconds()).padStart(2, '0') + '.' +
                           String(now.getMilliseconds()).padStart(3, '0');
                const tsSpan = document.createElement('span');
                tsSpan.className = 'timestamp'; tsSpan.textContent = '[' + ts + '] ';
                div.appendChild(tsSpan);
            }

            const dataSpan = document.createElement('span');
            dataSpan.className = 'data'; dataSpan.textContent = text;

            const active = getActiveFilters();
            if (active.length > 0) {
                const matched = matchFilters(text);
                if (matched.length > 0) {
                    dataSpan.style.color = matched[0].color;
                    dataSpan.style.background = hexToRgba(matched[0].color, 0.12);
                    dataSpan.style.borderRadius = '2px'; dataSpan.style.padding = '0 2px';
                } else if (filterOnly) { div.style.display = 'none'; }
            }

            div.appendChild(dataSpan);
            return div;
        }

        function updateVirtualScrollHeight() {
            // Update the spacer height to reflect total content
            const spacer = document.getElementById('virtualScrollSpacer');
            if (spacer) {
                spacer.style.height = (allLogLines.length * LINE_HEIGHT) + 'px';
            }
        }

        function renderVisibleLines() {
            if (!virtualScrollEnabled || allLogLines.length === 0) return;

            const scrollTop = logContent.scrollTop;
            const viewportHeight = logContent.clientHeight;

            // Calculate visible range
            const startIndex = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
            const endIndex = Math.min(allLogLines.length, Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + OVERSCAN);

            // Skip if range hasn't changed
            if (startIndex === renderStartIndex && endIndex === renderEndIndex) return;

            const oldStart = renderStartIndex;
            const oldEnd = renderEndIndex;
            renderStartIndex = startIndex;
            renderEndIndex = endIndex;

            const spacer = document.getElementById('virtualScrollSpacer');
            const active = getActiveFilters();

            // Release elements outside new range
            for (const [idx, el] of activeElements) {
                if (idx < startIndex || idx >= endIndex) {
                    el.remove();
                    releaseElement(el);
                    activeElements.delete(idx);
                }
            }

            // Add new elements for newly visible range
            const frag = document.createDocumentFragment();
            for (let i = startIndex; i < endIndex; i++) {
                if (!activeElements.has(i)) {
                    const line = updatePooledElement(getPooledElement(), allLogLines[i], i, active);
                    line.style.position = 'absolute';
                    line.style.top = (i * LINE_HEIGHT) + 'px';
                    line.style.width = '100%';
                    activeElements.set(i, line);
                    frag.appendChild(line);
                }
            }

            // Insert fragment before spacer
            if (frag.childNodes.length > 0 && spacer) {
                logContent.insertBefore(frag, spacer);
            }
        }

        function updatePooledElement(el, text, lineIndex, activeFilters) {
            el.setAttribute('data-index', String(lineIndex));
            
            const tsSpan = el.querySelector('.timestamp');
            const dataSpan = el.querySelector('.data');
            
            // Update timestamp
            if (showTimestamp) {
                const now = new Date();
                tsSpan.textContent = '[' + String(now.getHours()).padStart(2, '0') + ':' +
                    String(now.getMinutes()).padStart(2, '0') + ':' +
                    String(now.getSeconds()).padStart(2, '0') + '.' +
                    String(now.getMilliseconds()).padStart(3, '0') + '] ';
                tsSpan.style.display = '';
            } else {
                tsSpan.style.display = 'none';
            }

            // Update data
            dataSpan.textContent = text;
            dataSpan.style.color = '';
            dataSpan.style.background = '';
            dataSpan.style.borderRadius = '';
            dataSpan.style.padding = '';

            // Apply filters
            if (activeFilters && activeFilters.length > 0) {
                const matched = matchFilters(text);
                if (matched.length > 0) {
                    dataSpan.style.color = matched[0].color;
                    dataSpan.style.background = hexToRgba(matched[0].color, 0.12);
                    dataSpan.style.borderRadius = '2px';
                    dataSpan.style.padding = '0 2px';
                } else if (filterOnly) {
                    el.style.display = 'none';
                }
            } else {
                el.style.display = '';
            }

            return el;
        }

        function setupVirtualScroll() {
            // Create spacer element
            let spacer = document.getElementById('virtualScrollSpacer');
            if (!spacer) {
                spacer = document.createElement('div');
                spacer.id = 'virtualScrollSpacer';
                spacer.style.width = '1px';
                spacer.style.pointerEvents = 'none';
                logContent.appendChild(spacer);
            }

            // Switch to relative positioning for virtual scroll children
            // but preserve height with 100%
            logContent.style.position = 'relative';
            logContent.style.height = '100%';
            logContent.style.top = '0';
            logContent.style.left = '0';
            logContent.style.right = '0';
            logContent.style.bottom = '';

            // Add scroll listener with RAF throttling
            logContent.addEventListener('scroll', () => {
                if (scrollRAF) cancelAnimationFrame(scrollRAF);
                scrollRAF = requestAnimationFrame(() => {
                    renderVisibleLines();
                    scrollRAF = null;
                });
            });

            virtualScrollEnabled = true;
            renderVisibleLines();
        }

        function teardownVirtualScroll() {
            virtualScrollEnabled = false;
            // Release all elements to pool
            for (const [idx, el] of activeElements) {
                el.remove();
                releaseElement(el);
            }
            activeElements.clear();
            const spacer = document.getElementById('virtualScrollSpacer');
            if (spacer) spacer.remove();
            // Restore original positioning
            logContent.style.position = '';
            logContent.style.height = '';
            logContent.style.top = '';
            logContent.style.left = '';
            logContent.style.right = '';
            logContent.style.bottom = '';
        }

        // ---- Message handling ----
        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'log': appendLines(msg.lines); break;
                case 'snapshot': doClear(); appendLines(msg.lines); break;
                case 'clear': doClear(); break;
                case 'status': updateStatus(msg.connected, msg.info); break;
                case 'debug': if (dataCounterEl) { dataCounterEl.textContent = msg.text; } break;
            }
        });

        function appendLines(lines) {
            if (welcome) { welcome.style.display = 'none'; }
            if (paused) return;

            const linesLength = lines.length;
            const startLineIndex = allLogLines.length;

            // Store line data for virtual scrolling - batch push
            for (let i = 0; i < linesLength; i++) {
                const text = lines[i];
                allLogLines.push(text);
                allLogLineBytes.push(getLineByteSize(text));
                lineCount++;
                displayedBufferBytes += allLogLineBytes[allLogLineBytes.length - 1];
            }

            // Trim buffer if needed - batch remove from front
            if (displayedBufferBytes > maxBufferBytes) {
                let removeCount = 0;
                let removedBytes = 0;
                while (removedBytes < (displayedBufferBytes - maxBufferBytes) && removeCount < allLogLines.length) {
                    removedBytes += allLogLineBytes[removeCount];
                    removeCount++;
                }
                if (removeCount > 0) {
                    allLogLines.splice(0, removeCount);
                    allLogLineBytes.splice(0, removeCount);
                    displayedBufferBytes -= removedBytes;
                    lineCount -= removeCount;
                    // Adjust virtual scroll indices
                    renderStartIndex = Math.max(-1, renderStartIndex - removeCount);
                    renderEndIndex = Math.max(-1, renderEndIndex - removeCount);
                    // Re-index active elements
                    const newActive = new Map();
                    for (const [idx, el] of activeElements) {
                        const newIdx = idx - removeCount;
                        if (newIdx >= 0) {
                            newActive.set(newIdx, el);
                        } else {
                            el.remove();
                            releaseElement(el);
                        }
                    }
                    activeElements.clear();
                    for (const [idx, el] of newActive) {
                        activeElements.set(idx, el);
                    }
                }
            }

            // Check if we should enable virtual scrolling
            if (allLogLines.length > VIRTUAL_SCROLL_THRESHOLD && !virtualScrollEnabled) {
                setupVirtualScroll();
            }

            // Render based on mode
            if (virtualScrollEnabled) {
                updateVirtualScrollHeight();
                renderVisibleLines();
                if (autoScroll) { logContent.scrollTop = logContent.scrollHeight; }
            } else {
                // Original rendering for small datasets - batch DOM update
                const active = getActiveFilters();
                const frag = document.createDocumentFragment();
                for (let i = 0; i < linesLength; i++) {
                    const div = createLogLineElement(lines[i], startLineIndex + i);
                    frag.appendChild(div);
                }
                logContent.appendChild(frag);

                if (autoScroll) { logContent.scrollTop = logContent.scrollHeight; }
            }

            if (dataCounterEl) { dataCounterEl.textContent = lineCount; }
        }

        function doClear() {
            // Release all active elements back to pool
            for (const [idx, el] of activeElements) {
                releaseElement(el);
            }
            activeElements.clear();
            
            logContent.innerHTML = '';
            displayedBufferBytes = 0;
            allLogLines = [];
            allLogLineBytes = [];
            renderStartIndex = -1;
            renderEndIndex = -1;
            teardownVirtualScroll();
            if (welcome) { logContent.appendChild(welcome); welcome.style.display = ''; }
            lineCount = 0; searchMatches = []; currentSearchIndex = -1;
            searchCountEl.textContent = ''; filterCountEl.textContent = '';
            if (dataCounterEl) { dataCounterEl.textContent = '0'; }
        }

        function clearLog() { vscode.postMessage({ command: 'clear' }); doClear(); }
        function copyLog() { vscode.postMessage({ command: 'copy' }); }
        function saveLog() { vscode.postMessage({ command: 'save' }); }

        function updateStatus(connected, info) {
            if (connected) {
                statusDot.classList.add('connected'); statusText.textContent = info || 'Connected';
                btnConnect.classList.add('hidden'); btnDisconnect.classList.remove('hidden');
            } else {
                statusDot.classList.remove('connected'); statusText.textContent = info || 'Disconnected';
                btnConnect.classList.remove('hidden'); btnDisconnect.classList.add('hidden');
            }
        }

        function handleConnect() { vscode.postMessage({ command: 'connect' }); }
        function handleDisconnect() { vscode.postMessage({ command: 'disconnect' }); }

        function togglePause() {
            paused = !paused;
            if (paused) { btnPause.textContent = '▶ Resume'; pausedIndicator.classList.add('visible'); }
            else { btnPause.textContent = '⏸ Pause'; pausedIndicator.classList.remove('visible'); if (autoScroll) logContent.scrollTop = logContent.scrollHeight; }
        }

        function toggleAutoScroll() {
            autoScroll = !autoScroll;
            userScrolled = false;
            btnAutoScroll.textContent = autoScroll ? '⬇ Auto-scroll: ON' : '⬇ Auto-scroll: OFF';
            btnAutoScroll.classList.toggle('paused', !autoScroll);
            if (autoScroll) { logContent.scrollTop = logContent.scrollHeight; }
        }

        function toggleTimestamp() { showTimestamp = document.getElementById('chkTimestamp').checked; persistUiState(); }

        function toggleInput() {
            inputBar.classList.toggle('visible');
            if (inputBar.classList.contains('visible')) { document.getElementById('sendInput').focus(); }
        }

        function sendData() {
            const input = document.getElementById('sendInput');
            const hexMode = document.getElementById('hexMode');
            const text = input.value;
            if (text) {
                appendNewline = document.getElementById('appendNewline').checked;
                persistUiState();
                vscode.postMessage({ command: 'send', text, hex: hexMode.checked, appendNewline });
                input.value = '';
            }
        }

        // ---- Search ----
        let searchDebounce = undefined;
        let searchMatchIndices = []; // Store indices of matching lines for virtual scroll
        function onSearchInput() { persistUiState(); clearTimeout(searchDebounce); searchDebounce = setTimeout(performSearch, 200); }

        function performSearch() {
            const query = searchInput.value.trim();
            document.querySelectorAll('.search-match').forEach(el => {
                const parent = el.parentNode;
                parent.replaceChild(document.createTextNode(el.textContent), el);
                parent.normalize();
            });
            searchMatches = []; searchMatchIndices = []; currentSearchIndex = -1; searchCountEl.textContent = '';
            if (!query) return;

            let regex = null;
            if (searchRegex) {
                try { regex = new RegExp(query, 'gi'); } catch (e) { searchCountEl.textContent = 'Invalid regex'; return; }
            }

            if (virtualScrollEnabled) {
                // Search in allLogLines array for virtual scrolling
                for (let i = 0; i < allLogLines.length; i++) {
                    const text = allLogLines[i];
                    let isMatch = false;
                    if (regex) {
                        regex.lastIndex = 0;
                        isMatch = regex.test(text);
                    } else {
                        isMatch = text.toLowerCase().includes(query.toLowerCase());
                    }
                    if (isMatch) {
                        searchMatchIndices.push(i);
                    }
                }
                searchMatches = searchMatchIndices; // For compatibility with navigateSearch
                searchCountEl.textContent = searchMatchIndices.length > 0 ? '0/' + searchMatchIndices.length : 'No results';
                if (searchMatchIndices.length > 0) { navigateSearch(0); }
                return;
            }

            const dataSpans = logContent.querySelectorAll('.data');
            for (const span of dataSpans) {
                const text = span.textContent || '';
                const parts = [];

                if (regex) {
                    let m;
                    const re = new RegExp(query, 'gi');
                    while ((m = re.exec(text)) !== null) {
                        parts.push({ start: m.index, end: m.index + m[0].length });
                        if (m[0].length === 0) { re.lastIndex++; }
                    }
                } else {
                    const lowerText = text.toLowerCase();
                    const q = query.toLowerCase();
                    let lastIndex = 0;
                    let matchIdx;
                    while ((matchIdx = lowerText.indexOf(q, lastIndex)) !== -1) {
                        parts.push({ start: matchIdx, end: matchIdx + q.length });
                        lastIndex = matchIdx + 1;
                    }
                }

                if (parts.length > 0) {
                    const fragment = document.createDocumentFragment();
                    let pos = 0;
                    for (const part of parts) {
                        if (part.start > pos) { fragment.appendChild(document.createTextNode(text.slice(pos, part.start))); }
                        const mark = document.createElement('span');
                        mark.className = 'search-match'; mark.textContent = text.slice(part.start, part.end);
                        fragment.appendChild(mark); searchMatches.push(mark); pos = part.end;
                    }
                    if (pos < text.length) { fragment.appendChild(document.createTextNode(text.slice(pos))); }
                    span.textContent = ''; span.appendChild(fragment);
                }
            }
            searchCountEl.textContent = searchMatches.length > 0 ? '0/' + searchMatches.length : 'No results';
            if (searchMatches.length > 0) { navigateSearch(0); }
        }

        function navigateSearch(index) {
            if (searchMatches.length === 0) return;

            if (virtualScrollEnabled && searchMatchIndices.length > 0) {
                // Virtual scroll: navigate by line index
                if (currentSearchIndex >= 0) {
                    // Remove highlight from previous match
                    const prevLine = logContent.querySelector(`.log-line[data-index="${searchMatchIndices[currentSearchIndex]}"]`);
                    if (prevLine) prevLine.classList.remove('search-match-line');
                }
                currentSearchIndex = ((index % searchMatchIndices.length) + searchMatchIndices.length) % searchMatchIndices.length;
                const targetIndex = searchMatchIndices[currentSearchIndex];
                // Scroll to the target line
                logContent.scrollTop = targetIndex * LINE_HEIGHT - logContent.clientHeight / 2;
                // Re-render to show the highlighted line
                renderVisibleLines();
                // Add highlight to current match
                const currentLine = logContent.querySelector(`.log-line[data-index="${targetIndex}"]`);
                if (currentLine) currentLine.classList.add('search-match-line');
                searchCountEl.textContent = (currentSearchIndex + 1) + '/' + searchMatchIndices.length;
                return;
            }

            // Original behavior for non-virtual scroll
            if (currentSearchIndex >= 0 && currentSearchIndex < searchMatches.length) { searchMatches[currentSearchIndex].classList.remove('active'); }
            currentSearchIndex = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
            searchMatches[currentSearchIndex].classList.add('active');
            searchMatches[currentSearchIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
            searchCountEl.textContent = (currentSearchIndex + 1) + '/' + searchMatches.length;
        }

        function searchNext() { navigateSearch(currentSearchIndex + 1); }
        function searchPrev() { navigateSearch(currentSearchIndex - 1); }

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext(); }
            if (e.key === 'Escape') { searchInput.value = ''; persistUiState(); performSearch(); searchInput.blur(); }
        });

        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
        });

        function restoreUiState() {
            document.getElementById('chkFilterOnly').checked = filterOnly;
            document.getElementById('btnSearchRegex').classList.toggle('active', searchRegex);
            searchInput.value = persistedState.searchText || '';
            document.getElementById('chkTimestamp').checked = Boolean(persistedState.showTimestamp);
            showTimestamp = Boolean(persistedState.showTimestamp);
            document.getElementById('appendNewline').checked = appendNewline;
            quickCommands = quickCommands.map(normalizeQuickCommand).filter(item => item.text.length > 0);
            quickCommandId = quickCommands.reduce((maxId, item) => Math.max(maxId, item.id), -1) + 1;
            renderQuickCommands();

            const savedFilters = Array.isArray(persistedState.filters) ? persistedState.filters : [];
            filters = savedFilters.map((filter, index) => ({
                id: typeof filter.id === 'number' ? filter.id : index,
                text: typeof filter.text === 'string' ? filter.text : '',
                color: typeof filter.color === 'string' ? filter.color : DEFAULT_FILTER_COLORS[index % DEFAULT_FILTER_COLORS.length],
                enabled: filter.enabled !== false,
                regex: Boolean(filter.regex)
            }));
            filterId = filters.reduce((maxId, filter) => Math.max(maxId, filter.id), -1) + 1;
            for (const filter of filters) {
                renderFilterEntry(filter.id, filter.color, filter.text, filter.enabled, filter.regex, false);
            }
            if (searchInput.value) {
                performSearch();
            }
            applyFiltersToExisting();
        }

        restoreUiState();

        } catch (e) {
            document.body.innerHTML = '<div style="padding:20px;color:#f44747;font-family:monospace;white-space:pre-wrap;">'
                + 'WebView script error:\\n' + (e && e.stack || String(e)) + '</div>';
            try { const _vs = acquireVsCodeApi(); _vs.postMessage({ command: 'ready' }); _vs.postMessage({ command: 'requestStatus' }); } catch (_) {}
        }
    