import { DISPLAY_UNITS, type DisplayUnit } from '../engine/units.ts';
import type { Calibration, DrawingAnnotation, ItemAttrs, Markup, MarkupType, Pt } from '../engine/types';
import type { CustomColumn } from '../engine/export';
import type { Viewport } from '../engine/viewports';
import type { ToolPreset } from './state';

export interface ProjectLayerState {
  activeLayer?: string;
  hidden?: string[];
  layers?: { name: string; color?: string; locked?: boolean; order?: number }[];
}
export interface ProjectFile extends Record<string, unknown> {
  format: 'pdf2takeoff-project';
  version: 1;
  name?: string;
  drawing: string;
  pageNum?: number;
  displayUnit?: DisplayUnit;
  markups?: Markup[];
  annotations?: DrawingAnnotation[];
  calibrations?: [number, Calibration][];
  viewports?: Viewport[];
  presets?: ToolPreset[];
  columns?: CustomColumn[];
  template?: string | null;
  layerState?: ProjectLayerState;
}
export interface DecodedProject { project: ProjectFile; bytes: Uint8Array; name: string; pageNum: number; }
export interface ProjectDrawingLifecycle {
  validatePageCount(pageCount: number): void;
  initialize(): void | Promise<void>;
  beforeCommit?(): void | Promise<void>;
}
export interface ProjectOpenSteps {
  loadDrawing(bytes: Uint8Array, name: string, pageNum: number, lifecycle: ProjectDrawingLifecycle): Promise<void>;
  applyProject(project: ProjectFile, pageNum: number): void | Promise<void>;
  notifyOpened(name: string): void | Promise<void>;
}

const MARKUP_TYPES: MarkupType[] = ['length', 'area', 'count', 'perimeter', 'volume', 'angle', 'note'];
const ANNOTATION_KINDS = ['line', 'arrow', 'rectangle', 'ellipse', 'highlight', 'cloud', 'text'];
const ITEM_KINDS = ['Door', 'Window', 'Space'];
const ITEM_SOURCES = ['model', 'vector', 'cv', 'ocr', 'user'];
const DOOR_TYPES = ['swing', 'double_swing', 'sliding', 'pocket', 'bifold', 'garage', 'french_glazed', 'other'];
const GLAZING_TYPES = ['unit', 'sliding_glass_door', 'french_door', 'glazed_opening', 'other'];
const SPACE_KINDS = ['room', 'open_plan_zone', 'hallway', 'closet', 'storage_utility', 'wet', 'stair', 'outdoor', 'garage', 'other'];
const WET_KINDS = ['none', 'wc', 'bathroom', 'shower', 'sauna', 'washroom', 'lavatory'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isPositivePage(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isPoint(value: unknown): value is Pt {
  return isRecord(value) && typeof value.x === 'number' && Number.isFinite(value.x) &&
    typeof value.y === 'number' && Number.isFinite(value.y);
}
function isCalibration(value: unknown): value is Calibration {
  return isRecord(value) && typeof value.source === 'string' &&
    typeof value.metersPerPt === 'number' && Number.isFinite(value.metersPerPt) && value.metersPerPt > 0;
}
function isItemAttrs(value: unknown): value is ItemAttrs {
  return isRecord(value) && ITEM_KINDS.includes(String(value.kind)) && ITEM_SOURCES.includes(String(value.source)) &&
    (value.doorType === undefined || DOOR_TYPES.includes(String(value.doorType))) &&
    (value.leaves === undefined || (typeof value.leaves === 'number' && Number.isFinite(value.leaves) && value.leaves >= 0)) &&
    (value.closet === undefined || typeof value.closet === 'boolean') &&
    (value.glazingType === undefined || GLAZING_TYPES.includes(String(value.glazingType))) &&
    (value.group === undefined || typeof value.group === 'string') &&
    (value.spaceKind === undefined || SPACE_KINDS.includes(String(value.spaceKind))) &&
    (value.roomLabel === undefined || typeof value.roomLabel === 'string') &&
    (value.enclosed === undefined || typeof value.enclosed === 'boolean') &&
    (value.bedroom === undefined || typeof value.bedroom === 'boolean') &&
    (value.wetKind === undefined || WET_KINDS.includes(String(value.wetKind))) &&
    (value.agreement === undefined || (isRecord(value.agreement) &&
      typeof value.agreement.runs === 'number' && Number.isFinite(value.agreement.runs) && value.agreement.runs >= 0 &&
      typeof value.agreement.of === 'number' && Number.isFinite(value.agreement.of) && value.agreement.of >= value.agreement.runs));
}
function isMarkup(value: unknown): value is Markup {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id ||
      typeof value.label !== 'string' || !isPositivePage(value.page) ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) ||
      !MARKUP_TYPES.includes(value.type as MarkupType) ||
      !Array.isArray(value.points) || value.points.length > 10000 || !value.points.every(isPoint)) return false;
  const minPoints = value.type === 'length' ? 2 : ['area', 'perimeter', 'volume', 'angle'].includes(String(value.type)) ? 3 : 1;
  if (value.points.length < minPoints) return false;
  const strings = ['color', 'formula', 'itemCode', 'layer', 'parentId', 'remarks', 'sourceId'];
  const numbers = ['depth', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'timesing'];
  return strings.every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    numbers.every((key) => value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key]))) &&
    (value.depth === undefined || (typeof value.depth === 'number' && value.depth > 0)) &&
    (value.timesing === undefined || (typeof value.timesing === 'number' && value.timesing > 0)) &&
    (value.strokeWidth === undefined || (typeof value.strokeWidth === 'number' && value.strokeWidth > 0)) &&
    ['fillOpacity', 'strokeOpacity'].every((key) => value[key] === undefined || (typeof value[key] === 'number' && value[key] >= 0 && value[key] <= 1)) &&
    (value.calibration === undefined || isCalibration(value.calibration)) &&
    (value.item === undefined || isItemAttrs(value.item)) &&
    (value.links === undefined || (Array.isArray(value.links) && value.links.every((link) =>
      isRecord(link) && typeof link.markupId === 'string' && !!link.markupId &&
      ['logic', 'note', 'relation', 'variable'].every((key) => link[key] === undefined || typeof link[key] === 'string')))) &&
    (value.parameters === undefined || (isRecord(value.parameters) && Object.values(value.parameters).every((v) => typeof v === 'string'))) &&
    (value.sign === undefined || value.sign === 1 || value.sign === -1) &&
    (value.status === undefined || value.status === 'check' || value.status === 'confirmed') &&
    (value.visible === undefined || typeof value.visible === 'boolean') &&
    (value.lineStyle === undefined || ['solid', 'dashed', 'dotted'].includes(String(value.lineStyle)));
}
function isAnnotation(value: unknown): value is DrawingAnnotation {
  return isRecord(value) && typeof value.id === 'string' && !!value.id && isPositivePage(value.page) &&
    ANNOTATION_KINDS.includes(String(value.kind)) && Array.isArray(value.points) && value.points.length <= 10000 && value.points.every(isPoint) &&
    value.points.length >= (['line', 'arrow', 'rectangle', 'ellipse', 'highlight'].includes(String(value.kind)) ? 2 : String(value.kind) === 'cloud' ? 3 : 1) &&
    ['color', 'text'].every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    (value.strokeWidth === undefined || (typeof value.strokeWidth === 'number' && Number.isFinite(value.strokeWidth) && value.strokeWidth > 0)) &&
    ['opacity', 'fillOpacity'].every((key) => value[key] === undefined ||
      (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)) &&
    (value.lineStyle === undefined || ['solid', 'dashed', 'dotted'].includes(String(value.lineStyle)));
}
function isViewport(value: unknown): value is Viewport {
  return isRecord(value) && typeof value.id === 'string' && !!value.id && isPositivePage(value.page) &&
    Array.isArray(value.points) && value.points.length >= 3 && value.points.every(isPoint) &&
    isCalibration({ source: value.source, metersPerPt: value.metersPerPt });
}
function invalidField(field: string): never { throw new Error('Project file has invalid ' + field + '.'); }

function validateProject(project: Record<string, unknown>): asserts project is ProjectFile {
  if (project.format !== 'pdf2takeoff-project' || project.version !== 1) throw new Error('This is not a supported pdf2takeoff project file.');
  if (typeof project.drawing !== 'string' || !project.drawing.trim()) throw new Error('Project file is missing its embedded PDF.');
  if (project.name !== undefined && typeof project.name !== 'string') invalidField('name');
  if (project.pageNum !== undefined && !isPositivePage(project.pageNum)) invalidField('page number');
  if (project.displayUnit !== undefined && !DISPLAY_UNITS.includes(project.displayUnit as DisplayUnit)) invalidField('display unit');
  if (project.markups !== undefined && (!Array.isArray(project.markups) || !project.markups.every(isMarkup))) invalidField('measurements');
  if (project.annotations !== undefined && (!Array.isArray(project.annotations) || !project.annotations.every(isAnnotation))) invalidField('annotations');
  if (project.calibrations !== undefined && (!Array.isArray(project.calibrations) ||
      !project.calibrations.every((entry) => Array.isArray(entry) && entry.length === 2 && isPositivePage(entry[0]) && isCalibration(entry[1])) ||
      new Set(project.calibrations.map((entry) => entry[0])).size !== project.calibrations.length)) invalidField('calibrations');
  if (project.viewports !== undefined && (!Array.isArray(project.viewports) || !project.viewports.every(isViewport))) invalidField('viewports');
  if (project.presets !== undefined && (!Array.isArray(project.presets) ||
      !project.presets.every((p) => isRecord(p) && MARKUP_TYPES.includes(p.type as MarkupType) && typeof p.label === 'string' && !!p.label.trim()))) invalidField('presets');
  if (project.columns !== undefined && (!Array.isArray(project.columns) ||
      !project.columns.every((c) => isRecord(c) && typeof c.name === 'string' && !!c.name.trim() && typeof c.formula === 'string' && typeof c.unit === 'string'))) invalidField('quantity columns');
  if (project.template !== undefined && project.template !== null && typeof project.template !== 'string') invalidField('template');
  if (project.layerState !== undefined) {
    const layer = project.layerState;
    if (!isRecord(layer) ||
        (layer.activeLayer !== undefined && typeof layer.activeLayer !== 'string') ||
        (layer.hidden !== undefined && (!Array.isArray(layer.hidden) || !layer.hidden.every((x) => typeof x === 'string'))) ||
        (layer.layers !== undefined && (!Array.isArray(layer.layers) || !layer.layers.every((x) => isRecord(x) &&
          typeof x.name === 'string' && !!x.name.trim() &&
          (x.color === undefined || typeof x.color === 'string') &&
          (x.locked === undefined || typeof x.locked === 'boolean') &&
          (x.order === undefined || (typeof x.order === 'number' && Number.isFinite(x.order))))))) invalidField('layer state');
    if (Array.isArray(layer.layers)) {
      const names = layer.layers.map((x) => (x as { name: string }).name);
      if (new Set(names).size !== names.length) invalidField('layer state (duplicate names)');
      if (typeof layer.activeLayer === 'string' && !names.includes(layer.activeLayer)) invalidField('active layer reference');
    }
  }
  if (Array.isArray(project.markups)) {
    const ids = project.markups.map((m) => (m as Markup).id);
    if (new Set(ids).size !== ids.length) invalidField('measurements (duplicate ids)');
    const byId = new Map(project.markups.map((m) => [m.id, m]));
    for (const markup of project.markups) {
      let parent = markup.parentId;
      const seen = new Set([markup.id]);
      while (parent && byId.has(parent)) {
        if (seen.has(parent)) invalidField('measurement parent hierarchy');
        seen.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
  }
  if (Array.isArray(project.annotations)) {
    const ids = project.annotations.map((a) => (a as DrawingAnnotation).id);
    if (new Set(ids).size !== ids.length) invalidField('annotations (duplicate ids)');
  }
  if (Array.isArray(project.viewports)) {
    const ids = project.viewports.map((v) => (v as Viewport).id);
    if (new Set(ids).size !== ids.length) invalidField('viewports (duplicate ids)');
  }
}

export function validateProjectPageReferences(project: ProjectFile, pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('The PDF contains no pages.');
  const pages = [project.pageNum, ...(project.markups ?? []).map((m) => m.page),
    ...(project.annotations ?? []).map((a) => a.page), ...(project.calibrations ?? []).map(([p]) => p),
    ...(project.viewports ?? []).map((v) => v.page)].filter((p): p is number => p !== undefined);
  const invalid = pages.find((p) => p < 1 || p > pageCount);
  if (invalid !== undefined) throw new Error('Project data refers to page ' + invalid + ', but the embedded PDF has ' + pageCount + ' pages.');
}

export function decodeProjectFile(text: string): DecodedProject {
  if (text.length > 512 * 1024 * 1024) throw new Error('Project file is too large to open (maximum 512 MiB).');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error('Project file is not valid JSON: ' + (error instanceof Error ? error.message : String(error))); }
  if (!isRecord(value)) throw new Error('Project file must contain a JSON object.');
  validateProject(value);
  const base64 = value.drawing.replace(/\s+/g, '');
  if (base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('Project file contains invalid embedded PDF data.');
  }
  let binary: string;
  try { binary = atob(base64); }
  catch (error) { throw new Error('Project file contains invalid embedded PDF data: ' + (error instanceof Error ? error.message : String(error))); }
  if (!binary.length) throw new Error('Project file is missing its embedded PDF.');
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length < 5 || !String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024))).includes('%PDF-')) {
    throw new Error('Project file does not contain a PDF document.');
  }
  return { project: value, bytes, name: value.name?.trim() || 'project.pdf', pageNum: value.pageNum ?? 1 };
}

export async function openProjectText(text: string, steps: ProjectOpenSteps): Promise<void> {
  const decoded = decodeProjectFile(text);
  await steps.loadDrawing(decoded.bytes, decoded.name, decoded.pageNum, {
    validatePageCount: (count) => validateProjectPageReferences(decoded.project, count),
    initialize: () => steps.applyProject(decoded.project, decoded.pageNum),
    beforeCommit: () => steps.notifyOpened(decoded.name),
  });
}
