import { ItemView, Menu, WorkspaceLeaf } from 'obsidian';
import type AiNotesPlugin from './main';

export const GRAPH_VIEW = 'eduaiot-ai-notes-graph';

type Kind = 'topic' | 'note';
type EdgeKind = 'member' | 'bridge' | 'link';

interface GNode {
  id: string;
  kind: Kind;
  label: string;
  topic: number;
  path: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  pinned: boolean;
  fresh: boolean;
}

interface GEdge {
  a: GNode;
  b: GNode;
  kind: EdgeKind;
}

const LIMITS = [10, 20, 40, 80];
const SPRING: Record<EdgeKind, [number, number]> = { member: [70, 0.04], bridge: [180, 0.02], link: [60, 0.03] };

function color(topic: number, alpha = 1) {
  return `hsla(${(topic * 137.5) % 360}, 65%, 55%, ${alpha})`;
}

export class TopicGraphView extends ItemView {
  private nodes: GNode[] = [];
  private edges: GEdge[] = [];
  private names = new Map<number, string>();
  private summaries = new Map<number, string>();
  private hidden = new Set<number>();
  private limit = 20;
  private query = '';
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private alpha = 1;
  private frame = 0;
  private hover: GNode | null = null;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private legend!: HTMLElement;
  private tip!: HTMLElement;
  private observer: ResizeObserver | null = null;
  private reader: WorkspaceLeaf | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: AiNotesPlugin) {
    super(leaf);
  }

  getViewType() {
    return GRAPH_VIEW;
  }

  getDisplayText() {
    return '主题图谱';
  }

  getIcon() {
    return 'git-fork';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('eai-graph');
    const bar = root.createDiv({ cls: 'eai-graph-bar' });
    const search = bar.createEl('input', { type: 'text', attr: { placeholder: '搜索高亮' } });
    search.oninput = () => {
      this.query = search.value.trim().toLowerCase();
      this.draw();
    };
    const select = bar.createEl('select', { cls: 'dropdown' });
    for (const value of LIMITS) select.createEl('option', { text: `每个主题 ${value} 篇`, value: String(value) });
    select.value = String(this.limit);
    select.onchange = () => {
      this.limit = Number(select.value);
      void this.reload();
    };
    bar.createEl('button', { text: '居中' }).onclick = () => this.fit();
    bar.createEl('button', { text: '重新分析' }).onclick = async () => {
      if (await this.plugin.topics.build(false)) await this.reload();
    };
    this.legend = root.createDiv({ cls: 'eai-graph-legend' });
    const stage = root.createDiv({ cls: 'eai-graph-stage' });
    this.canvas = stage.createEl('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = stage.createDiv({ cls: 'eai-graph-tip' });
    this.tip.hide();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(stage);
    this.bind();
    await this.reload();
  }

  async onClose() {
    window.cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
  }

  async reload() {
    await this.plugin.local.start();
    const joined = await this.plugin.topics.catchUp();
    const state = await this.plugin.topics.state();
    const engine = this.plugin.local.engine;
    this.nodes = [];
    this.edges = [];
    this.legend.empty();
    if (!state) {
      this.legend.createSpan({ cls: 'eai-hint', text: '还没有主题地图。' });
      this.legend.createEl('button', { cls: 'mod-cta', text: '生成主题地图' }).onclick = async () => {
        if (await this.plugin.topics.build(false)) await this.reload();
      };
      this.draw();
      return;
    }
    const fresh = new Set(state.added ?? []);
    const byPath = new Map<string, GNode>();
    const bridged = new Set(state.bridges.flatMap((bridge) => [bridge.a, bridge.b]));
    const count = state.topics.length;
    state.topics.forEach((topic, i) => {
      this.names.set(topic.id, topic.name);
      this.summaries.set(topic.id, topic.summary);
      const angle = (2 * Math.PI * i) / Math.max(count, 1);
      const hub: GNode = { id: `topic-${topic.id}`, kind: 'topic', label: topic.name, topic: topic.id, path: '', x: Math.cos(angle) * 320, y: Math.sin(angle) * 320, vx: 0, vy: 0, r: 14, pinned: false, fresh: false };
      this.nodes.push(hub);
      const paths = [...topic.paths.filter((path) => bridged.has(path) || fresh.has(path)), ...topic.paths].filter((path, n, list) => list.indexOf(path) === n && engine.has(path)).slice(0, this.limit);
      for (const path of paths) {
        const node: GNode = { id: path, kind: 'note', label: engine.title(path), topic: topic.id, path, x: hub.x + (Math.random() - 0.5) * 120, y: hub.y + (Math.random() - 0.5) * 120, vx: 0, vy: 0, r: 5, pinned: false, fresh: fresh.has(path) };
        this.nodes.push(node);
        byPath.set(path, node);
        this.edges.push({ a: hub, b: node, kind: 'member' });
      }
      const chip = this.legend.createSpan({ cls: 'eai-graph-chip', text: `${topic.name} · ${topic.paths.length} 篇` });
      if (topic.summary) chip.title = topic.summary;
      chip.setCssProps({ '--eai-topic': color(topic.id) });
      chip.toggleClass('is-off', this.hidden.has(topic.id));
      chip.onclick = () => {
        if (this.hidden.has(topic.id)) this.hidden.delete(topic.id);
        else this.hidden.add(topic.id);
        chip.toggleClass('is-off', this.hidden.has(topic.id));
        this.kick();
      };
    });
    for (const bridge of state.bridges) {
      const a = byPath.get(bridge.a);
      const b = byPath.get(bridge.b);
      if (a && b) this.edges.push({ a, b, kind: 'bridge' });
    }
    const seen = new Set<string>();
    for (const [from, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      const a = byPath.get(from);
      if (!a) continue;
      for (const to of Object.keys(targets)) {
        const b = byPath.get(to);
        const key = [from, to].sort().join('\n');
        if (!b || b === a || seen.has(key)) continue;
        seen.add(key);
        this.edges.push({ a, b, kind: 'link' });
      }
    }
    for (const edge of this.edges) {
      if (edge.kind === 'member') continue;
      edge.a.r = Math.min(edge.a.r + 1, 10);
      edge.b.r = Math.min(edge.b.r + 1, 10);
    }
    const many = fresh.size >= Math.max(5, Math.round((state.total ?? 0) * 0.3));
    if (fresh.size) {
      const note = this.legend.createSpan({ cls: many ? 'eai-warn' : 'eai-hint', text: many ? `新加入了 ${fresh.size} 篇笔记，建议点「重新分析」重新分组` : `${joined ? `刚自动加入 ${joined} 篇新笔记，` : ''}带白圈的是新加入的笔记` });
      note.title = '新笔记会自动放进内容最接近的主题；放得不对，可以右键笔记换主题';
    }
    const tip = this.legend.createSpan({ cls: 'eai-hint', text: '点笔记打开，右键换主题，拖动节点或背景，滚轮缩放。紫色虚线是跨领域连接，灰线是笔记之间的双链。' });
    tip.setCssStyles({ marginLeft: 'auto' });
    this.fit();
    this.kick();
  }

  private visible(node: GNode) {
    return !this.hidden.has(node.topic);
  }

  private kick() {
    this.alpha = 1;
    window.cancelAnimationFrame(this.frame);
    const step = () => {
      this.tick();
      this.draw();
      this.alpha *= 0.985;
      if (this.alpha > 0.01) this.frame = window.requestAnimationFrame(step);
    };
    this.frame = window.requestAnimationFrame(step);
  }

  private tick() {
    const nodes = this.nodes.filter((node) => this.visible(node));
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.5;
        }
        if (d2 > 250000) continue;
        const strength = ((a.kind === 'topic' ? 4 : 1) * (b.kind === 'topic' ? 4 : 1) * 900) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * strength;
        const fy = (dy / d) * strength;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    for (const edge of this.edges) {
      if (!this.visible(edge.a) || !this.visible(edge.b)) continue;
      const [length, k] = SPRING[edge.kind];
      const dx = edge.b.x - edge.a.x;
      const dy = edge.b.y - edge.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (d - length) * k;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      edge.a.vx += fx;
      edge.a.vy += fy;
      edge.b.vx -= fx;
      edge.b.vy -= fy;
    }
    for (const node of nodes) {
      node.vx -= node.x * 0.002;
      node.vy -= node.y * 0.002;
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.x += Math.max(-30, Math.min(30, node.vx * this.alpha));
      node.y += Math.max(-30, Math.min(30, node.vy * this.alpha));
      node.vx *= 0.6;
      node.vy *= 0.6;
    }
  }

  private resize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    this.canvas.setCssStyles({ width: `${rect.width}px`, height: `${rect.height}px` });
    this.draw();
  }

  private fit() {
    const rect = this.canvas.getBoundingClientRect();
    const visible = this.nodes.filter((node) => this.visible(node));
    if (!visible.length || !rect.width) {
      this.ox = rect.width / 2;
      this.oy = rect.height / 2;
      this.draw();
      return;
    }
    const xs = visible.map((node) => node.x);
    const ys = visible.map((node) => node.y);
    const w = Math.max(...xs) - Math.min(...xs) + 200;
    const h = Math.max(...ys) - Math.min(...ys) + 200;
    this.scale = Math.max(0.2, Math.min(2, Math.min(rect.width / w, rect.height / h)));
    this.ox = rect.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * this.scale;
    this.oy = rect.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * this.scale;
    this.draw();
  }

  private neighbors(node: GNode | null): Set<GNode> {
    const out = new Set<GNode>();
    if (!node) return out;
    out.add(node);
    for (const edge of this.edges) {
      if (edge.a === node) out.add(edge.b);
      if (edge.b === node) out.add(edge.a);
    }
    return out;
  }

  private draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const style = getComputedStyle(this.contentEl);
    const text = style.getPropertyValue('--text-normal') || '#888';
    const faint = style.getPropertyValue('--text-faint') || '#999';
    const family = style.getPropertyValue('--font-interface').trim() || 'sans-serif';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(ratio * this.scale, 0, 0, ratio * this.scale, ratio * this.ox, ratio * this.oy);
    const focus = this.neighbors(this.hover);
    const matched = (node: GNode) => !!this.query && node.label.toLowerCase().includes(this.query);
    const dim = (node: GNode) => (this.hover ? !focus.has(node) : this.query ? !matched(node) && node.kind !== 'topic' : false);
    for (const edge of this.edges) {
      if (!this.visible(edge.a) || !this.visible(edge.b)) continue;
      const faded = dim(edge.a) || dim(edge.b);
      ctx.beginPath();
      ctx.moveTo(edge.a.x, edge.a.y);
      ctx.lineTo(edge.b.x, edge.b.y);
      ctx.setLineDash(edge.kind === 'bridge' ? [6, 4] : []);
      ctx.lineWidth = (edge.kind === 'bridge' ? 2.2 : edge.kind === 'link' ? 1.2 : 0.8) / Math.sqrt(this.scale);
      ctx.strokeStyle = edge.kind === 'bridge' ? `rgba(160, 90, 220, ${faded ? 0.15 : 0.9})` : edge.kind === 'link' ? `rgba(128, 128, 128, ${faded ? 0.08 : 0.5})` : color(edge.a.topic, faded ? 0.06 : 0.3);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const node of this.nodes) {
      if (!this.visible(node)) continue;
      const faded = dim(node);
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = color(node.topic, faded ? 0.2 : node.kind === 'topic' ? 1 : 0.85);
      ctx.fill();
      if (node.fresh && !faded) {
        ctx.lineWidth = 1.5 / this.scale;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.stroke();
      }
      if (matched(node) || node === this.hover) {
        ctx.lineWidth = 2 / this.scale;
        ctx.strokeStyle = text;
        ctx.stroke();
      }
      const label = node.kind === 'topic' || node === this.hover || matched(node) || (this.hover && focus.has(node)) || this.scale > 1.3;
      if (!label || (faded && node.kind !== 'topic')) continue;
      const size = (node.kind === 'topic' ? 15 : 11) / Math.max(this.scale, 0.6);
      ctx.font = `${node.kind === 'topic' ? 'bold ' : ''}${size}px ${family}`;
      ctx.fillStyle = faded ? faint : text;
      ctx.textAlign = 'center';
      const name = node.label.length > 18 ? `${node.label.slice(0, 18)}…` : node.label;
      ctx.fillText(node.kind === 'topic' ? node.label : name, node.x, node.y + node.r + size + 2);
      const summary = node.kind === 'topic' ? this.summaries.get(node.topic) ?? '' : '';
      if (summary && (this.scale > 0.7 || node === this.hover)) {
        const small = 11 / Math.max(this.scale, 0.6);
        ctx.font = `${small}px ${family}`;
        ctx.fillStyle = faint;
        ctx.fillText(summary.length > 24 ? `${summary.slice(0, 24)}…` : summary, node.x, node.y + node.r + size + small + 6);
      }
    }
  }

  private point(event: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.ox) / this.scale, y: (event.clientY - rect.top - this.oy) / this.scale };
  }

  private pick(event: MouseEvent): GNode | null {
    const { x, y } = this.point(event);
    let best: GNode | null = null;
    let distance = Infinity;
    for (const node of this.nodes) {
      if (!this.visible(node)) continue;
      const d = Math.hypot(node.x - x, node.y - y);
      if (d < Math.max(node.r + 4, 8 / this.scale) && d < distance) {
        best = node;
        distance = d;
      }
    }
    return best;
  }

  private bind() {
    let dragging: GNode | null = null;
    let panning = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.onpointerdown = (event) => {
      if (event.button !== 0) return;
      this.canvas.setPointerCapture(event.pointerId);
      dragging = this.pick(event);
      panning = !dragging;
      moved = false;
      lastX = event.clientX;
      lastY = event.clientY;
      if (dragging) dragging.pinned = true;
    };
    this.canvas.onpointermove = (event) => {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      lastX = event.clientX;
      lastY = event.clientY;
      if (dragging) {
        const { x, y } = this.point(event);
        dragging.x = x;
        dragging.y = y;
        if (this.alpha < 0.3) this.kick();
        return;
      }
      if (panning) {
        this.ox += dx;
        this.oy += dy;
        this.draw();
        return;
      }
      const node = this.pick(event);
      if (node !== this.hover) {
        this.hover = node;
        this.canvas.setCssStyles({ cursor: node ? 'pointer' : 'grab' });
        this.showTip(node, event);
        this.draw();
      } else if (node) {
        this.showTip(node, event);
      }
    };
    this.canvas.onpointerup = (event) => {
      const node = dragging;
      if (node) node.pinned = false;
      dragging = null;
      panning = false;
      if (moved || !node) return;
      if (node.kind === 'note') void this.plugin.openNote(node.path, '', -1, event.metaKey || event.ctrlKey ? true : this.noteLeaf());
      else this.focusTopic(node);
    };
    this.canvas.oncontextmenu = (event) => {
      event.preventDefault();
      const node = this.pick(event);
      if (!node || node.kind !== 'note') return;
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('打开笔记').setIcon('file-text').onClick(() => void this.plugin.openNote(node.path, '', -1, this.noteLeaf())));
      menu.addSeparator();
      for (const [id, name] of this.names) {
        if (id === node.topic) continue;
        menu.addItem((item) => item.setTitle(`移到「${name}」`).setIcon('folder-input').onClick(async () => {
          if (await this.plugin.topics.move(node.path, id)) await this.reload();
        }));
      }
      menu.showAtMouseEvent(event);
    };
    this.canvas.onpointerleave = () => {
      this.hover = null;
      this.tip.hide();
      this.draw();
    };
    this.canvas.onwheel = (event) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const next = Math.max(0.15, Math.min(4, this.scale * Math.exp(-event.deltaY * 0.0015)));
      this.ox = mx - ((mx - this.ox) / this.scale) * next;
      this.oy = my - ((my - this.oy) / this.scale) * next;
      this.scale = next;
      this.draw();
    };
  }

  private showTip(node: GNode | null, event: MouseEvent) {
    if (!node) {
      this.tip.hide();
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const summary = this.summaries.get(node.topic) ?? '';
    this.tip.setText(node.kind === 'topic' ? `${node.label}${summary ? `\n${summary}` : ''}\n点一下放大` : `${node.label}\n${this.names.get(node.topic) ?? ''}${node.fresh ? ' · 新加入' : ''} · 点击打开，右键换主题`);
    this.tip.setCssStyles({ left: `${event.clientX - rect.left + 12}px`, top: `${event.clientY - rect.top + 12}px` });
    this.tip.show();
  }

  private noteLeaf(): WorkspaceLeaf {
    if (this.reader && this.app.workspace.getLeavesOfType('markdown').includes(this.reader)) return this.reader;
    this.reader = this.app.workspace.createLeafBySplit(this.leaf, 'vertical');
    return this.reader;
  }

  private focusTopic(node: GNode) {
    const rect = this.canvas.getBoundingClientRect();
    this.scale = Math.max(this.scale, 1.4);
    this.ox = rect.width / 2 - node.x * this.scale;
    this.oy = rect.height / 2 - node.y * this.scale;
    this.draw();
  }
}
