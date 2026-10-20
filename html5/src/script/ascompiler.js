// AngelScript -> JavaScript compiler for the subset used by PowerSlave
// Exhumed's game scripts (scripts/*.txt). It preprocesses #include/#define,
// level script "$script N { }" blocks, parses to an AST and emits JS with
// enough static typing to keep AngelScript semantics for value types
// (kVec3/kQuat copies), integer division/truncation and operator overloads.

import { API, GLOBAL_FUNCS, NAMESPACES, PROP_REFS, typeBase } from './asapi.js';

// ------------------------------------------------------------------ lexing

const PUNCT = [
    '>>>=', '<<=', '>>=', '!is', '...', '::', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
    '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!',
    '=', '<', '>', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}', '@', '#', '$',
];

function tokenize(src, file) {
    const toks = [];
    let i = 0, line = 1;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '\n') { line++; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            const end = e < 0 ? n : e + 2;
            for (let k = i; k < end; ++k) if (src[k] === '\n') line++;
            i = end;
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1, s = '';
            while (j < n && src[j] !== c) {
                if (src[j] === '\\') { s += src[j] + src[j + 1]; j += 2; continue; }
                s += src[j++];
            }
            toks.push({ t: 'str', v: s, line, file });
            i = j + 1;
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
            const m = /^(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)([fFdDuUlL]*)/.exec(src.slice(i, i + 64));
            const txt = m[1];
            const isFloat = /[.eE]/.test(txt) && !/^0[xX]/.test(txt) || /[fFdD]/.test(m[3]);
            toks.push({ t: 'num', v: txt, float: isFloat, line, file });
            i += m[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i, i + 128));
            toks.push({ t: 'id', v: m[0], line, file });
            i += m[0].length;
            continue;
        }
        let p = null;
        for (const q of PUNCT) if (src.startsWith(q, i)) { p = q; break; }
        if (!p) throw new Error(`${file}:${line}: unexpected character '${c}'`);
        // "!is" only when followed by a non-identifier char
        if (p === '!is' && /[A-Za-z_0-9]/.test(src[i + 3] || '')) p = '!';
        toks.push({ t: 'p', v: p, line, file });
        i += p.length;
    }
    return toks;
}

// ------------------------------------------------------------ preprocessing

// Expands #include/#define/#if 0 and level script directives into a token list.
function preprocess(entry, readFile, state = { included: new Set(), defines: new Map() }) {
    const out = [];
    const src = readFile(entry);
    if (src == null) throw new Error(`script: cannot open ${entry}`);
    state.included.add(entry.toLowerCase());
    const lines = src.replace(/\r/g, '').split('\n');
    let body = '';
    let skipDepth = 0;
    const expand = (toks, depth = 0) => {
        const res = [];
        for (let k = 0; k < toks.length; ++k) {
            const t = toks[k];
            const def = t.t === 'id' ? state.defines.get(t.v) : null;
            if (!def || depth > 16) { res.push(t); continue; }
            if (def.params) {
                if (!(toks[k + 1] && toks[k + 1].v === '(')) { res.push(t); continue; }
                // collect arguments
                const args = [[]];
                let level = 0, j = k + 2;
                for (; j < toks.length; ++j) {
                    const a = toks[j];
                    if (a.t === 'p' && (a.v === '(' || a.v === '[' || a.v === '{')) level++;
                    if (a.t === 'p' && (a.v === ')' || a.v === ']' || a.v === '}')) {
                        if (level === 0) break;
                        level--;
                    }
                    if (a.t === 'p' && a.v === ',' && level === 0) { args.push([]); continue; }
                    args[args.length - 1].push(a);
                }
                const body = [];
                for (const b of def.body) {
                    const pi = b.t === 'id' ? def.params.indexOf(b.v) : -1;
                    if (pi >= 0) body.push(...(args[pi] || []));
                    else body.push({ ...b, line: t.line, file: t.file });
                }
                res.push(...expand(body, depth + 1));
                k = j;
                continue;
            }
            res.push(...expand(def.body.map((r) => ({ ...r, line: t.line, file: t.file })), depth + 1));
        }
        return res;
    };
    const flush = (lineNo) => {
        if (!body) return;
        const toks = tokenize(body, entry);
        for (const t of toks) t.line += lineNo;
        out.push(...expand(toks));
        body = '';
    };
    let bodyStart = 0;
    for (let ln = 0; ln < lines.length; ++ln) {
        const line = lines[ln];
        const m = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
        if (m) {
            const dir = m[1], rest = m[2].replace(/\/\/.*$/, '').trim();
            if (dir === 'if') { if (skipDepth || rest === '0') skipDepth++; else if (skipDepth) skipDepth++; body += '\n'; continue; }
            if (dir === 'endif') { if (skipDepth) skipDepth--; body += '\n'; continue; }
            if (dir === 'else') { if (skipDepth === 1) skipDepth = 0; else if (!skipDepth) skipDepth = 1; body += '\n'; continue; }
            if (skipDepth) { body += '\n'; continue; }
            flush(bodyStart);
            bodyStart = ln + 1;
            if (dir === 'include') {
                const f = /"([^"]+)"/.exec(rest)[1];
                if (!state.included.has(f.toLowerCase())) out.push(...preprocess(f, readFile, state));
            } else if (dir === 'define') {
                const fm = /^(\w+)\(([^)]*)\)\s*(.*)$/.exec(rest);
                if (fm) {
                    state.defines.set(fm[1], { params: fm[2].split(',').map((x) => x.trim()).filter(Boolean), body: tokenize(fm[3], entry) });
                } else {
                    const dm = /^(\w+)\s*(.*)$/.exec(rest);
                    state.defines.set(dm[1], { params: null, body: dm[2] ? tokenize(dm[2], entry) : [] });
                }
            }
            continue;
        }
        body += (skipDepth ? '' : line) + '\n';
    }
    flush(bodyStart);
    return out;
}

// ------------------------------------------------------------------ parsing

const BUILTIN_TYPES = new Set([
    'void', 'bool', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'float', 'double', 'auto', 'kStr', 'kVec3', 'kAngle', 'kQuat', 'array',
]);

class Parser {
    constructor(toks) {
        this.toks = toks;
        this.i = 0;
        this.typeNames = new Set([...BUILTIN_TYPES, ...Object.keys(API)]);
    }
    peek(o = 0) { return this.toks[this.i + o] || { t: 'eof', v: null }; }
    next() { return this.toks[this.i++] || { t: 'eof', v: null }; }
    is(v, o = 0) { const t = this.peek(o); return t.v === v && t.t !== 'str'; }
    accept(v) { if (this.is(v)) { this.i++; return true; } return false; }
    expect(v) {
        const t = this.next();
        if (t.v !== v || t.t === 'str') this.error(`expected '${v}' got '${t.v}'`, t);
        return t;
    }
    error(msg, t = this.peek()) {
        const ctx = this.toks.slice(Math.max(0, this.i - 12), this.i + 6).map((x) => x.v).join(' ');
        throw new Error(`${t.file}:${t.line}: ${msg}\n  near: ${ctx}`);
    }

    isTypeName(name) { return this.typeNames.has(name) || /^Enum[A-Z]/.test(name); }

    // Try to parse a type at the current position; returns null (and restores) on failure.
    tryType() {
        const save = this.i;
        let isConst = false;
        if (this.accept('const')) isConst = true;
        const t = this.peek();
        if (t.t !== 'id') { this.i = save; return null; }
        let name = t.v;
        if (!this.isTypeName(name) && !(this.peek(1).t === 'id' || this.is('@', 1) || this.is('&', 1))) {
            this.i = save; return null;
        }
        if (['return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'delete', 'new'].includes(name)) {
            this.i = save; return null;
        }
        this.i++;
        let sub = null;
        if (this.is('<') && (name === 'array' || this.isTypeName(name))) {
            this.i++;
            sub = this.tryType();
            if (!sub || !this.accept('>')) { this.i = save; return null; }
            name = `array<${sub.name}>`;
        }
        let handle = false, ref = false;
        for (;;) {
            if (this.accept('@')) { handle = true; continue; }
            if (this.is('&')) {
                this.i++; ref = true;
                if (this.is('in') || this.is('out') || this.is('inout')) this.i++;
                continue;
            }
            if (this.accept('const')) continue;
            break;
        }
        return { name, handle, ref, isConst };
    }

    parseProgram() {
        const items = [];
        while (this.peek().t !== 'eof') {
            if (this.accept(';')) continue;
            if (this.is('$') && this.peek(1).v === 'script') {
                this.i += 2;
                const num = Number(this.next().v);
                const body = this.parseBlock();
                items.push({ k: 'script', num, body });
                continue;
            }
            if (this.is('enum')) { items.push(this.parseEnum()); continue; }
            if (this.is('class') || ((this.is('final') || this.is('shared')) && this.is('class', 1))) {
                items.push(this.parseClass());
                continue;
            }
            if (this.is('funcdef') || this.is('import')) { while (!this.accept(';')) this.next(); continue; }
            items.push(...this.parseDeclOrFunc(true));
        }
        return items;
    }

    parseEnum() {
        this.expect('enum');
        const name = this.next().v;
        this.typeNames.add(name);
        this.expect('{');
        const values = [];
        let cur = -1;
        while (!this.accept('}')) {
            const id = this.next().v;
            let val;
            if (this.accept('=')) val = this.parseTernary(); else val = null;
            values.push({ id, val });
            this.accept(',');
        }
        this.accept(';');
        void cur;
        return { k: 'enum', name, values };
    }

    parseClass() {
        while (this.is('final') || this.is('shared')) this.next();
        this.expect('class');
        const name = this.next().v;
        this.typeNames.add(name);
        if (this.accept(':')) while (!this.is('{')) this.next();
        this.expect('{');
        const fields = [], methods = [], ctors = [];
        while (!this.accept('}')) {
            if (this.accept(';')) continue;
            // constructor
            if (this.is(name) && this.is('(', 1)) {
                this.i++;
                const params = this.parseParams();
                const body = this.parseBlock();
                ctors.push({ params, body });
                continue;
            }
            const decls = this.parseDeclOrFunc(false);
            for (const d of decls) {
                if (d.k === 'func') methods.push(d); else fields.push(...d.vars);
            }
        }
        this.accept(';');
        return { k: 'class', name, fields, methods, ctors };
    }

    parseParams() {
        this.expect('(');
        const params = [];
        if (this.is('void') && this.is(')', 1)) { this.i++; }
        while (!this.accept(')')) {
            const type = this.tryType();
            if (!type) this.error('expected parameter type');
            let pname = null;
            if (this.peek().t === 'id') pname = this.next().v;
            let def = null;
            if (this.accept('=')) def = this.parseAssign();
            params.push({ type, name: pname || `$p${params.length}`, def });
            this.accept(',');
        }
        return params;
    }

    parseDeclOrFunc(top) {
        const type = this.tryType();
        if (!type) this.error(`expected declaration, got '${this.peek().v}'`);
        const nameTok = this.next();
        if (nameTok.t !== 'id') this.error('expected identifier', nameTok);
        if (this.is('(')) {
            // function definition or constructor-style variable init
            const save = this.i;
            let params = null;
            try {
                params = this.parseParams();
                while (this.is('const') || this.is('override') || this.is('final')) this.next();
            } catch (e) {
                params = null;
            }
            if (params && this.is('{')) {
                const body = this.parseBlock();
                return [{ k: 'func', ret: type, name: nameTok.v, params, body }];
            }
            if (params && this.accept(';')) return [{ k: 'proto', ret: type, name: nameTok.v, params }];
            this.i = save;
        }
        const vars = [];
        let name = nameTok.v;
        for (;;) {
            let init = null, ctorArgs = null;
            if (this.accept('=')) {
                if (this.is('{')) init = this.parseInitList();
                else init = this.parseAssign();
            } else if (this.is('(')) {
                ctorArgs = this.parseArgs();
            }
            vars.push({ type, name, init, ctorArgs });
            if (this.accept(',')) { name = this.next().v; continue; }
            break;
        }
        this.expect(';');
        return [{ k: 'var', vars, top }];
    }

    parseInitList() {
        this.expect('{');
        const items = [];
        while (!this.accept('}')) {
            if (this.is('{')) items.push(this.parseInitList());
            else items.push(this.parseAssign());
            this.accept(',');
        }
        return { k: 'initlist', items };
    }

    parseBlock() {
        this.expect('{');
        const stmts = [];
        while (!this.accept('}')) {
            if (this.peek().t === 'eof') this.error('unexpected end of file in block');
            stmts.push(this.parseStatement());
        }
        return { k: 'block', stmts };
    }

    looksLikeDecl() {
        const save = this.i;
        const type = this.tryType();
        const ok = !!type && this.peek().t === 'id' &&
            (this.is('=', 1) || this.is(';', 1) || this.is(',', 1) || this.is('(', 1) || this.is('[', 1));
        this.i = save;
        return ok;
    }

    parseStatement() {
        const t = this.peek();
        if (t.v === '{' && t.t === 'p') return this.parseBlock();
        if (t.v === ';' && t.t === 'p') { this.i++; return { k: 'empty' }; }
        if (t.v === '$' && this.peek(1).v === 'restart') { this.i += 2; this.accept(';'); return { k: 'restart' }; }
        if (t.t === 'id') {
            switch (t.v) {
            case 'if': {
                this.i++; this.expect('(');
                const cond = this.parseExpr(); this.expect(')');
                const then = this.parseStatement();
                let els = null;
                if (this.accept('else')) els = this.parseStatement();
                return { k: 'if', cond, then, els };
            }
            case 'while': {
                this.i++; this.expect('(');
                const cond = this.parseExpr(); this.expect(')');
                return { k: 'while', cond, body: this.parseStatement() };
            }
            case 'do': {
                this.i++;
                const body = this.parseStatement();
                this.expect('while'); this.expect('(');
                const cond = this.parseExpr(); this.expect(')'); this.accept(';');
                return { k: 'do', cond, body };
            }
            case 'for': {
                this.i++; this.expect('(');
                let init = null;
                if (!this.is(';')) {
                    if (this.looksLikeDecl()) init = this.parseDeclOrFunc(false)[0];
                    else { init = { k: 'expr', e: this.parseExpr() }; this.expect(';'); }
                } else this.expect(';');
                const cond = this.is(';') ? null : this.parseExpr();
                this.expect(';');
                const steps = [];
                while (!this.is(')')) { steps.push(this.parseExpr()); this.accept(','); }
                this.expect(')');
                return { k: 'for', init, cond, steps, body: this.parseStatement() };
            }
            case 'switch': {
                this.i++; this.expect('(');
                const disc = this.parseExpr(); this.expect(')');
                this.expect('{');
                const cases = [];
                let cur = null;
                while (!this.accept('}')) {
                    if (this.accept('case')) {
                        const test = this.parseTernary();
                        this.expect(':');
                        cur = { test, body: [] };
                        cases.push(cur);
                    } else if (this.accept('default')) {
                        this.expect(':');
                        cur = { test: null, body: [] };
                        cases.push(cur);
                    } else {
                        if (!cur) this.error('statement outside case');
                        cur.body.push(this.parseStatement());
                    }
                }
                return { k: 'switch', disc, cases };
            }
            case 'break': this.i++; this.accept(';'); return { k: 'break' };
            case 'continue': this.i++; this.accept(';'); return { k: 'continue' };
            case 'return': {
                this.i++;
                const e = this.is(';') ? null : this.parseExpr();
                this.expect(';');
                return { k: 'return', e };
            }
            default: break;
            }
            if (this.looksLikeDecl()) return this.parseDeclOrFunc(false)[0];
        }
        const e = this.parseExpr();
        this.expect(';');
        return { k: 'expr', e };
    }

    parseArgs() {
        this.expect('(');
        const args = [];
        while (!this.accept(')')) {
            args.push(this.parseAssign());
            this.accept(',');
        }
        return args;
    }

    parseExpr() {
        const e = this.parseAssign();
        if (this.is(',')) {
            const list = [e];
            while (this.accept(',')) list.push(this.parseAssign());
            return { k: 'comma', list };
        }
        return e;
    }

    parseAssign() {
        // handle assignment "@a = b"
        if (this.is('@')) {
            const save = this.i;
            this.i++;
            const lhs = this.parseUnary();
            if (this.accept('=')) {
                const rhs = this.parseAssign();
                return { k: 'hassign', lhs, rhs };
            }
            this.i = save;
        }
        const lhs = this.parseTernary();
        const t = this.peek();
        if (t.t === 'p' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>='].includes(t.v)) {
            this.i++;
            const rhs = this.parseAssign();
            return { k: 'assign', op: t.v, lhs, rhs };
        }
        return lhs;
    }

    parseTernary() {
        const cond = this.parseBin(0);
        if (this.accept('?')) {
            const a = this.parseAssign();
            this.expect(':');
            const b = this.parseAssign();
            return { k: 'cond', cond, a, b };
        }
        return cond;
    }

    parseBin(level) {
        const LEVELS = [
            ['||', 'or'], ['&&', 'and'], ['^^', 'xor'], ['|'], ['^'], ['&'],
            ['==', '!=', 'is', '!is'], ['<', '>', '<=', '>='], ['<<', '>>', '>>>'], ['+', '-'], ['*', '/', '%'],
        ];
        if (level >= LEVELS.length) return this.parseUnary();
        let lhs = this.parseBin(level + 1);
        for (;;) {
            const t = this.peek();
            if ((t.t === 'p' || t.t === 'id') && LEVELS[level].includes(t.v)) {
                this.i++;
                let op = t.v;
                if (op === 'or') op = '||';
                if (op === 'and') op = '&&';
                if (op === 'is' && this.is('null') === false && false) op = 'is';
                const rhs = this.parseBin(level + 1);
                lhs = { k: 'bin', op, lhs, rhs };
            } else break;
        }
        return lhs;
    }

    parseUnary() {
        const t = this.peek();
        if (t.t === 'p' && ['!', '-', '+', '~', '++', '--', '@'].includes(t.v)) {
            this.i++;
            const e = this.parseUnary();
            if (t.v === '@') return e;
            return { k: 'unary', op: t.v, e };
        }
        if (t.t === 'id' && t.v === 'not') { this.i++; return { k: 'unary', op: '!', e: this.parseUnary() }; }
        // casts: cast<T>(x)
        if (t.t === 'id' && t.v === 'cast' && this.is('<', 1)) {
            this.i += 2;
            const type = this.tryType();
            this.expect('>');
            this.expect('(');
            const e = this.parseExpr();
            this.expect(')');
            return { k: 'cast', type, e };
        }
        return this.parsePostfix(this.parsePrimary());
    }

    parsePostfix(e) {
        for (;;) {
            if (this.is('.')) {
                this.i++;
                const name = this.next().v;
                if (this.is('(')) e = { k: 'mcall', obj: e, name, args: this.parseArgs() };
                else e = { k: 'member', obj: e, name };
                continue;
            }
            if (this.is('[')) {
                this.i++;
                const idx = this.parseExpr();
                this.expect(']');
                e = { k: 'index', obj: e, idx };
                continue;
            }
            if (this.is('++') || this.is('--')) {
                const op = this.next().v;
                e = { k: 'postfix', op, e };
                continue;
            }
            break;
        }
        return e;
    }

    parsePrimary() {
        const t = this.next();
        if (t.t === 'num') return { k: 'num', v: t.v, float: t.float };
        if (t.t === 'str') {
            let s = t.v;
            while (this.peek().t === 'str') s += this.next().v; // adjacent literal concatenation
            return { k: 'str', v: s };
        }
        if (t.t === 'p' && t.v === '(') {
            const e = this.parseExpr();
            this.expect(')');
            return { k: 'paren', e };
        }
        if (t.t === 'p' && t.v === '::') {
            const name = this.next().v;
            if (this.is('(')) return { k: 'call', name, args: this.parseArgs() };
            return { k: 'id', name };
        }
        if (t.t === 'id') {
            if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
            if (t.v === 'null') return { k: 'null' };
            if (t.v === 'this') return { k: 'this' };
            let name = t.v;
            if (this.is('::')) {
                this.i++;
                const member = this.next().v;
                if (this.is('(')) return { k: 'nscall', ns: name, name: member, args: this.parseArgs() };
                return { k: 'nsid', ns: name, name: member };
            }
            if (name === 'array' && this.is('<')) {
                this.i--;
                const type = this.tryType();
                if (this.is('(')) return { k: 'construct', type: type.name, args: this.parseArgs() };
                if (this.is('{')) return { k: 'initlist', ...this.parseInitList(), type: type.name };
                this.error('bad array expression');
            }
            if (this.is('(')) return { k: 'call', name, args: this.parseArgs() };
            return { k: 'id', name };
        }
        this.error(`unexpected token '${t.v}'`, t);
    }
}

// ----------------------------------------------------------------- emitting

const INT_TYPES = new Set(['int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64']);
const NUM_TYPES = new Set([...INT_TYPES, 'float', 'double', 'kAngle', 'bool']);
const VALUE_CLASSES = new Set(['kVec3', 'kQuat']);

function isInt(t) { return !!t && (INT_TYPES.has(t) || /^Enum/.test(t) || t === 'enum'); }
function isNum(t) { return !!t && (NUM_TYPES.has(t) || isInt(t)); }

function intCoerce(type, code) {
    switch (type) {
    case 'uint8': return `((${code}) & 255)`;
    case 'int8': return `(((${code}) << 24) >> 24)`;
    case 'uint16': return `((${code}) & 65535)`;
    case 'int16': return `(((${code}) << 16) >> 16)`;
    case 'uint': case 'uint32': return `((${code}) >>> 0)`;
    default: return `((${code}) | 0)`;
    }
}

const JS_RESERVED = new Set(['var', 'let', 'function', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'yield',
    'await', 'arguments', 'eval', 'with', 'class', 'export', 'import', 'super', 'enum', 'static', 'implements',
    'interface', 'package', 'private', 'protected', 'public', 'Object', 'Array', 'String', 'Math', 'Number']);

function jsName(n) { return JS_RESERVED.has(n) ? `$${n}` : n; }

export class Emitter {
    constructor(program, opts = {}) {
        this.program = program;
        this.opts = opts;
        this.globals = new Map();
        this.funcs = new Map();
        this.classes = new Map();
        this.enumValues = new Map();
        this.scopes = [];
        this.curClass = null;
        this.inScript = false;
        this.out = [];
    }

    // ---- types
    elemType(t) {
        const m = t && /^array<(.+)>$/.exec(t);
        return m ? m[1] : null;
    }

    lookupVar(name) {
        for (let i = this.scopes.length - 1; i >= 0; --i) {
            if (this.scopes[i].has(name)) return { type: this.scopes[i].get(name), code: jsName(name) };
        }
        if (this.curClass) {
            const f = this.curClass.fieldTypes.get(name);
            if (f !== undefined) return { type: f, code: `this.${name}` };
        }
        if (this.globals.has(name)) return { type: this.globals.get(name), code: jsName(name) };
        if (this.enumValues.has(name)) return { type: 'int', code: jsName(name) };
        return null;
    }

    memberType(objType, name, isCall) {
        if (!objType) return null;
        const base = typeBase(objType);
        if (this.classes.has(base)) {
            const c = this.classes.get(base);
            if (!isCall) return c.fieldTypes.get(name) ?? null;
            const m = c.methods.get(name);
            return m ? m.ret.name : null;
        }
        if (this.elemType(base)) {
            if (name === 'length' || name === 'size') return 'uint';
            if (name === 'find' || name === 'findByRef') return 'int';
            return null;
        }
        const api = API[base];
        if (!api) return null;
        const v = api[name];
        if (v === undefined && api.$extends) return this.memberType(api.$extends, name, isCall);
        return v ?? null;
    }

    // ---- emit helpers
    emitProgram() {
        const P = this.program;
        // pass 1: collect declarations
        for (const it of P) {
            if (it.k === 'enum') {
                let cur = -1;
                for (const v of it.values) {
                    this.enumValues.set(v.id, true);
                    if (v.val == null) cur++;
                }
            } else if (it.k === 'class') {
                const c = { name: it.name, fieldTypes: new Map(), methods: new Map(), node: it };
                for (const f of it.fields) c.fieldTypes.set(f.name, f.type.name);
                for (const m of it.methods) c.methods.set(m.name, m);
                this.classes.set(it.name, c);
            } else if (it.k === 'func' || it.k === 'proto') {
                if (it.k === 'func') this.funcs.set(it.name, it);
            } else if (it.k === 'var') {
                for (const v of it.vars) this.globals.set(v.name, v.type.name);
            }
        }
        const lines = [];
        // enums
        for (const it of P) {
            if (it.k !== 'enum') continue;
            let cur = -1;
            for (const v of it.values) {
                if (v.val != null) { lines.push(`const ${jsName(v.id)} = ${this.expr(v.val).c};`); cur = `${jsName(v.id)}`; }
                else { lines.push(`const ${jsName(v.id)} = ${cur === -1 ? 0 : `${cur} + 1`};`); cur = jsName(v.id); }
            }
        }
        // classes
        for (const it of P) if (it.k === 'class') lines.push(this.emitClass(it));
        // globals (declared first, initialized in order)
        const inits = [];
        for (const it of P) {
            if (it.k !== 'var') continue;
            for (const v of it.vars) {
                lines.push(`let ${jsName(v.name)};`);
                inits.push(`${jsName(v.name)} = ${this.declInit(v)};`);
            }
        }
        // functions
        for (const it of P) if (it.k === 'func') lines.push(this.emitFunction(it, false));
        const scripts = [];
        for (const it of P) {
            if (it.k !== 'script') continue;
            this.inScript = true;
            this.scopes = [new Map([['instigator', 'kexSlaveActor']])];
            const body = this.block(it.body, 1);
            this.inScript = false;
            this.scopes = [];
            lines.push(`function* mapscript_${it.num}(instigator) ${body}`);
            scripts.push(it.num);
        }
        lines.push(`function $init() {\n${inits.map((s) => '    ' + s).join('\n')}\n}`);
        const fnNames = [...this.funcs.keys()].map((n) => `${JSON.stringify(n)}: ${jsName(n)}`);
        lines.push(`return { init: $init, functions: { ${fnNames.join(', ')} }, scripts: { ${scripts.map((n) => `${n}: mapscript_${n}`).join(', ')} } };`);
        return lines.join('\n');
    }

    defaultValue(type) {
        const t = typeBase(type.name);
        if (type.handle) return 'null';
        if (isNum(t)) return t === 'bool' ? 'false' : '0';
        if (t === 'kStr') return "''";
        if (t === 'kVec3') return 'new Vec3()';
        if (t === 'kQuat') return 'new Quat()';
        if (this.elemType(t)) return '[]';
        if (this.classes.has(t)) return `new ${jsName(t)}()`;
        return 'null';
    }

    declInit(v) {
        const t = v.type.name;
        if (v.init) {
            if (v.init.k === 'initlist') return this.initList(v.init, t);
            const e = this.expr(v.init, t);
            return this.convert(e, v.type);
        }
        if (v.ctorArgs) return this.construct(t, v.ctorArgs).c;
        return this.defaultValue(v.type);
    }

    initList(node, type) {
        const et = this.elemType(type);
        const items = node.items.map((it) => (it.k === 'initlist' ? this.initList(it, et) : this.convert(this.expr(it, et), { name: et })));
        return `[${items.join(', ')}]`;
    }

    // value conversion on assignment/initialization
    convert(e, type) {
        const t = typeBase(type.name || type);
        if (!type.handle && VALUE_CLASSES.has(t)) return `$clone(${e.c})`;
        if (isInt(t) && e.t && !isInt(e.t)) return intCoerce(t, e.c);
        if (isInt(t) && !e.t) return intCoerce(t, e.c);
        if (t === 'kAngle') return `$ang(${e.c})`;
        return e.c;
    }

    emitClass(it) {
        const c = this.classes.get(it.name);
        const prev = this.curClass;
        this.curClass = c;
        const lines = [`class ${jsName(it.name)} {`];
        lines.push('    constructor(...$a) {');
        for (const f of it.fields) lines.push(`        this.${f.name} = ${f.init ? this.declInit(f) : this.defaultValue(f.type)};`);
        if (it.ctors.length) {
            lines.push('        switch ($a.length) {');
            for (const ctor of it.ctors) {
                this.scopes = [new Map()];
                const ps = ctor.params.map((p, i) => { this.scopes[0].set(p.name, p.type.name); return `let ${jsName(p.name)} = $a[${i}];`; });
                lines.push(`        case ${ctor.params.length}: { ${ps.join(' ')} ${this.block(ctor.body, 3)} break; }`);
            }
            lines.push('        }');
        }
        lines.push('    }');
        for (const m of it.methods) lines.push('    ' + this.emitFunction(m, true).replace(/^function /, ''));
        lines.push('}');
        this.scopes = [];
        this.curClass = prev;
        return lines.join('\n');
    }

    emitFunction(f, isMethod) {
        this.scopes = [new Map()];
        this.curRet = f.ret;
        const params = f.params.map((p) => {
            this.scopes[0].set(p.name, p.type.name);
            return p.def ? `${jsName(p.name)} = ${this.expr(p.def).c}` : jsName(p.name);
        });
        // by-value copies of value-class params
        const copies = f.params.filter((p) => !p.type.ref && !p.type.handle && VALUE_CLASSES.has(typeBase(p.type.name)))
            .map((p) => `${jsName(p.name)} = $clone(${jsName(p.name)});`);
        let body = this.block(f.body, 1);
        if (copies.length) body = `{ ${copies.join(' ')}${body.slice(1)}`;
        this.scopes = [];
        return `function ${jsName(f.name)}(${params.join(', ')}) ${body}`;
    }

    ind(n) { return '    '.repeat(n); }

    block(b, depth) {
        this.scopes.push(new Map());
        const out = b.stmts.map((s) => this.stmt(s, depth)).join('\n');
        this.scopes.pop();
        return `{\n${out}\n${this.ind(depth - 1)}}`;
    }

    stmt(s, d) {
        const I = this.ind(d);
        switch (s.k) {
        case 'block': return I + this.block(s, d + 1);
        case 'empty': return I + ';';
        case 'expr': return I + this.expr(s.e, null, true).c + ';';
        case 'var': {
            const parts = s.vars.map((v) => {
                const init = this.declInit(v);
                this.scopes[this.scopes.length - 1].set(v.name, v.type.name);
                return `${jsName(v.name)} = ${init}`;
            });
            return `${I}let ${parts.join(', ')};`;
        }
        case 'if': {
            let r = `${I}if (${this.cond(s.cond)}) ${this.wrap(s.then, d)}`;
            if (s.els) r += ` else ${this.wrap(s.els, d)}`;
            return r;
        }
        case 'while': return `${I}while (${this.cond(s.cond)}) ${this.wrap(s.body, d)}`;
        case 'do': return `${I}do ${this.wrap(s.body, d)} while (${this.cond(s.cond)});`;
        case 'for': {
            this.scopes.push(new Map());
            let init = '';
            if (s.init) {
                if (s.init.k === 'var') init = this.stmt(s.init, 0).replace(/;$/, '');
                else init = this.expr(s.init.e, null, true).c;
            }
            const cond = s.cond ? this.cond(s.cond) : '';
            const steps = s.steps.map((e) => this.expr(e, null, true).c).join(', ');
            const body = this.wrap(s.body, d);
            this.scopes.pop();
            return `${I}for (${init}; ${cond}; ${steps}) ${body}`;
        }
        case 'switch': {
            const lines = [`${I}switch (${this.expr(s.disc).c}) {`];
            this.scopes.push(new Map());
            for (const c of s.cases) {
                lines.push(c.test ? `${I}case ${this.expr(c.test).c}:` : `${I}default:`);
                for (const st of c.body) lines.push(this.stmt(st, d + 1));
            }
            this.scopes.pop();
            lines.push(`${I}}`);
            return lines.join('\n');
        }
        case 'break': return `${I}break;`;
        case 'continue': return `${I}continue;`;
        case 'return': {
            if (!s.e) return `${I}return;`;
            const e = this.expr(s.e, this.curRet && this.curRet.name);
            return `${I}return ${this.curRet && !this.inScript ? this.convert(e, this.curRet) : e.c};`;
        }
        case 'restart': return `${I}$rt.restartScript(instigator);`;
        default: throw new Error(`emit: unknown statement ${s.k}`);
        }
    }

    wrap(s, d) {
        if (s.k === 'block') return this.block(s, d + 1);
        return `{\n${this.stmt(s, d + 1)}\n${this.ind(d)}}`;
    }

    cond(e) { return this.expr(e).c; }

    construct(type, args) {
        const t = typeBase(type);
        const a = args.map((x) => this.expr(x).c);
        if (t === 'kVec3') return { c: `new Vec3(${a.join(', ')})`, t: 'kVec3' };
        if (t === 'kQuat') return { c: `new Quat(${a.join(', ')})`, t: 'kQuat' };
        if (t === 'kAngle') return { c: `$ang(${a[0] ?? 0})`, t: 'kAngle' };
        if (t === 'kStr') return { c: `String(${a[0] ?? "''"})`, t: 'kStr' };
        if (this.elemType(t)) return { c: `$newArray(${a.join(', ')})`, t };
        if (isInt(t)) return { c: intCoerce(t, a[0] ?? 0), t };
        if (t === 'float' || t === 'double') return { c: `(+(${a[0] ?? 0}))`, t: 'float' };
        if (t === 'bool') return { c: `(!!(${a[0]}))`, t: 'bool' };
        if (this.classes.has(t)) return { c: `new ${jsName(t)}(${a.join(', ')})`, t };
        return { c: `$construct(${JSON.stringify(t)}, ${a.join(', ')})`, t };
    }

    // ---- expressions: returns { c: code, t: type }
    expr(e, hint = null, isStmt = false) {
        switch (e.k) {
        case 'num': {
            if (/^0[xX]/.test(e.v)) return { c: String(Number(e.v)), t: 'int' };
            return { c: String(Number(e.v)), t: e.float ? 'float' : 'int' };
        }
        case 'str': return { c: JSON.stringify(e.v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')), t: 'kStr' };
        case 'bool': return { c: String(e.v), t: 'bool' };
        case 'null': return { c: 'null', t: null };
        case 'this': return { c: 'this', t: this.curClass ? this.curClass.name : null };
        case 'paren': { const r = this.expr(e.e, hint); return { c: `(${r.c})`, t: r.t }; }
        case 'id': {
            const v = this.lookupVar(e.name);
            if (v) return { c: v.code, t: v.type };
            if (this.funcs.has(e.name)) return { c: jsName(e.name), t: 'funcptr' };
            return { c: `$c.${e.name}`, t: 'int' };
        }
        case 'nsid': {
            return { c: `$ns.${e.ns}.${e.name}`, t: (NAMESPACES[e.ns] || {})[e.name] ?? null };
        }
        case 'nscall': {
            const args = e.args.map((a) => this.expr(a).c);
            const ret = (NAMESPACES[e.ns] || {})[e.name] ?? null;
            if (e.name === 'delay' && this.inScript) return { c: `(yield ${args[0]})`, t: 'void' };
            return { c: `$ns.${e.ns}.${e.name}(${args.join(', ')})`, t: ret };
        }
        case 'call': return this.call(e);
        case 'mcall': return this.mcall(e);
        case 'member': {
            const o = this.expr(e.obj);
            return { c: `${o.c}.${e.name}`, t: this.memberType(o.t, e.name, false) };
        }
        case 'index': {
            const o = this.expr(e.obj);
            const i = this.expr(e.idx);
            const et = this.elemType(typeBase(o.t)) || (typeBase(o.t) === 'kStr' ? 'int' : null);
            if (typeBase(o.t) === 'kStr') return { c: `${o.c}.charCodeAt(${i.c})`, t: 'int' };
            return { c: `${o.c}[${i.c}]`, t: et };
        }
        case 'postfix': {
            const lv = this.lvalue(e.e);
            return { c: `${lv.c}${e.op}`, t: lv.t };
        }
        case 'unary': {
            if (e.op === '++' || e.op === '--') {
                const lv = this.lvalue(e.e);
                return { c: `${e.op}${lv.c}`, t: lv.t };
            }
            const r = this.expr(e.e);
            if (e.op === '-' && (r.t === 'kVec3' || r.t === 'kQuat')) return { c: `${r.c}.neg()`, t: r.t };
            if (e.op === '-' && !r.t) return { c: `$op.neg(${r.c})`, t: null };
            if (e.op === '!') return { c: `!${r.c}`, t: 'bool' };
            if (e.op === '~') return { c: `~${r.c}`, t: 'int' };
            return { c: `${e.op}${r.c}`, t: r.t === 'bool' ? 'int' : r.t };
        }
        case 'cast': {
            const r = this.expr(e.e);
            return { c: r.c, t: e.type.name };
        }
        case 'cond': {
            const c = this.expr(e.cond).c;
            const a = this.expr(e.a, hint), b = this.expr(e.b, hint);
            return { c: `(${c} ? ${a.c} : ${b.c})`, t: a.t || b.t };
        }
        case 'comma': return { c: e.list.map((x) => this.expr(x, null, true).c).join(', '), t: null };
        case 'bin': return this.binary(e);
        case 'assign': return this.assign(e, isStmt);
        case 'hassign': {
            const l = this.lvalue(e.lhs);
            const r = this.expr(e.rhs);
            return { c: `${l.c} = ${r.c}`, t: l.t };
        }
        case 'construct': return this.construct(e.type, e.args);
        case 'initlist': return { c: this.initList(e, e.type || hint), t: e.type || hint };
        default: throw new Error(`emit: unknown expression ${e.k}`);
        }
    }

    call(e) {
        const name = e.name;
        // constructors / conversions
        if (BUILTIN_TYPES.has(name) || this.classes.has(name)) return this.construct(name, e.args);
        if (name === 'delay') {
            const a = e.args.map((x) => this.expr(x).c);
            return this.inScript ? { c: `(yield ${a[0]})`, t: 'void' } : { c: 'undefined', t: 'void' };
        }
        const f = this.funcs.get(name);
        if (f) {
            const args = e.args.map((x, i) => {
                const r = this.expr(x);
                const p = f.params[i];
                if (!p) return r.c;
                if (p.type.ref || p.type.handle) return r.c;
                return this.convert(r, p.type);
            });
            return { c: `${jsName(name)}(${args.join(', ')})`, t: f.ret.name };
        }
        // method call on 'this' inside a class
        if (this.curClass && this.curClass.methods.has(name)) {
            const m = this.curClass.methods.get(name);
            return { c: `this.${name}(${e.args.map((x) => this.expr(x).c).join(', ')})`, t: m.ret.name };
        }
        const v = this.lookupVar(name);
        if (v) return { c: `${v.code}(${e.args.map((x) => this.expr(x).c).join(', ')})`, t: null };
        const ret = GLOBAL_FUNCS[name];
        return { c: `$g.${name}(${e.args.map((x) => this.expr(x).c).join(', ')})`, t: ret === undefined ? null : ret };
    }

    mcall(e) {
        const o = this.expr(e.obj);
        const base = typeBase(o.t);
        const args = e.args.map((x) => this.expr(x).c);
        if ((this.elemType(base) || base === 'kStr') && (e.name === 'length' || e.name === 'size')) {
            return { c: `${o.c}.length`, t: 'uint' };
        }
        if (this.elemType(base)) {
            switch (e.name) {
            case 'insertLast': return { c: `${o.c}.push(${args[0]})`, t: 'void' };
            case 'removeLast': return { c: `${o.c}.pop()`, t: 'void' };
            case 'removeAt': return { c: `${o.c}.splice(${args[0]}, 1)`, t: 'void' };
            case 'insertAt': return { c: `${o.c}.splice(${args[0]}, 0, ${args[1]})`, t: 'void' };
            case 'resize': return { c: `$resize(${o.c}, ${args[0]})`, t: 'void' };
            case 'find': return { c: `${o.c}.indexOf(${args[0]})`, t: 'int' };
            case 'isEmpty': return { c: `(${o.c}.length === 0)`, t: 'bool' };
            default: break;
            }
        }
        if (!o.t && (e.name === 'length')) return { c: `$len(${o.c})`, t: 'uint' };
        const ret = this.memberType(o.t, e.name, true);
        return { c: `${o.c}.${e.name}(${args.join(', ')})`, t: ret };
    }

    // Lvalue for assignment; getter calls returning references become property access.
    lvalue(e) {
        if (e.k === 'paren') return this.lvalue(e.e);
        if (e.k === 'mcall' && e.args.length === 0) {
            const o = this.expr(e.obj);
            const t = this.memberType(o.t, e.name, true);
            const prop = PROP_REFS[e.name];
            if (VALUE_CLASSES.has(typeBase(t)) || typeBase(t) === 'slaveRotation_s') {
                return { c: `${o.c}.${e.name}()`, t, valueRef: true };
            }
            if (prop) return { c: `${o.c}.${prop}`, t };
            throw new Error(`cannot assign to ${e.name}()`);
        }
        const r = this.expr(e);
        return { c: r.c, t: r.t, valueRef: VALUE_CLASSES.has(typeBase(r.t)) };
    }

    assign(e, isStmt) {
        const l = this.lvalue(e.lhs);
        const lt = typeBase(l.t);
        const r = this.expr(e.rhs, lt);
        if (VALUE_CLASSES.has(lt)) {
            if (e.op === '=') return { c: `${l.c}.copy(${r.c})`, t: lt };
            const op = { '+=': 'add', '-=': 'sub', '*=': 'mul', '/=': 'div' }[e.op];
            return { c: `${l.c}.copy($op.${op}(${l.c}, ${r.c}))`, t: lt };
        }
        if (e.op === '=') {
            const v = isInt(lt) && r.t && !isInt(r.t) ? intCoerce(lt, r.c) : (lt === 'kAngle' ? `$ang(${r.c})` : r.c);
            return { c: `${l.c} = ${v}`, t: lt };
        }
        if (isInt(lt) && (e.op === '/=' || ((e.op === '*=' || e.op === '+=' || e.op === '-=') && r.t && !isInt(r.t)))) {
            const op = e.op.slice(0, -1);
            const rhs = op === '/' ? `$idiv(${l.c}, ${r.c})` : intCoerce(lt, `${l.c} ${op} ${r.c}`);
            return { c: `${l.c} = ${rhs}`, t: lt };
        }
        if (lt === 'kAngle' && (e.op === '+=' || e.op === '-=')) {
            return { c: `${l.c} = $ang(${l.c} ${e.op[0]} ${r.c})`, t: lt };
        }
        void isStmt;
        return { c: `${l.c} ${e.op} ${r.c}`, t: lt };
    }

    binary(e) {
        const op = e.op;
        if (op === 'is' || op === '!is') {
            const l = this.expr(e.lhs), r = this.expr(e.rhs);
            if (r.c === 'null') return { c: `(${l.c} ${op === 'is' ? '==' : '!='} null)`, t: 'bool' };
            return { c: `(${l.c} ${op === 'is' ? '===' : '!=='} ${r.c})`, t: 'bool' };
        }
        const l = this.expr(e.lhs), r = this.expr(e.rhs);
        const lt = typeBase(l.t), rt = typeBase(r.t);
        if (op === '&&' || op === '||') return { c: `(${l.c} ${op} ${r.c})`, t: 'bool' };
        if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
            if (VALUE_CLASSES.has(lt) && (op === '==' || op === '!=')) {
                return { c: `${op === '!=' ? '!' : ''}$op.eq(${l.c}, ${r.c})`, t: 'bool' };
            }
            const jop = op === '==' ? '===' : op === '!=' ? '!==' : op;
            if (op === '==' || op === '!=') {
                // loose compare when types are unknown (e.g. bool vs int)
                const loose = !(lt && rt && lt === rt);
                return { c: `(${l.c} ${loose ? op : jop} ${r.c})`, t: 'bool' };
            }
            return { c: `(${l.c} ${jop} ${r.c})`, t: 'bool' };
        }
        if (['&', '|', '^', '<<', '>>', '>>>'].includes(op)) return { c: `(${l.c} ${op} ${r.c})`, t: isInt(lt) ? lt : 'int' };
        if (lt === 'kStr' || rt === 'kStr') {
            if (op === '+') return { c: `(${l.c} + ${r.c})`, t: 'kStr' };
        }
        if (isNum(lt) && isNum(rt)) {
            if (op === '/' && isInt(lt) && isInt(rt)) return { c: `$idiv(${l.c}, ${r.c})`, t: 'int' };
            if (op === '%' && isInt(lt) && isInt(rt)) return { c: `$imod(${l.c}, ${r.c})`, t: 'int' };
            const rtype = isInt(lt) && isInt(rt) ? (lt === rt ? lt : 'int') : (lt === 'kAngle' ? 'kAngle' : 'float');
            if (rtype === 'kAngle' && (op === '+' || op === '-')) return { c: `$ang(${l.c} ${op} ${r.c})`, t: 'kAngle' };
            return { c: `(${l.c} ${op} ${r.c})`, t: rtype === 'kAngle' ? 'float' : rtype };
        }
        // operator overloads / unknown types: dispatch at runtime
        const fn = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod' }[op];
        let t = null;
        if (lt === 'kVec3') t = 'kVec3';
        else if (lt === 'kQuat' && rt === 'kQuat') t = 'kQuat';
        else if (isNum(lt) && rt === 'kVec3') t = 'kVec3';
        else if (isNum(lt) && isNum(rt)) t = 'float';
        return { c: `$op.${fn}(${l.c}, ${r.c})`, t };
    }
}

// Compiles a script entry file. readFile(path) returns source text or null.
export function compileScript(entry, readFile, opts = {}) {
    const toks = preprocess(entry, readFile);
    const parser = new Parser(toks);
    const program = parser.parseProgram();
    const emitter = new Emitter(program, opts);
    return emitter.emitProgram();
}

export { tokenize, preprocess, Parser };
