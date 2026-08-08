import type {
  CommandEnvelopeV1,
  WikiPageCreatePayloadV1,
  WikiPageEditPayloadV1,
  WikiPageSetStatePayloadV1,
  WikiSpaceCreatePayloadV1
} from '@casa-clara/contracts';

import { createCommandEnvelope } from '$lib/offline/schema';
import { queueCommand, type QueueOutcome } from '$lib/offline/queue-command';

/**
 * Constructores puros de envelopes para la wiki. Producen los payloads
 * CONGELADOS del contrato; la validación zod vive en los tests y en el
 * servidor, nunca en el bundle del navegador. `operationId`/`occurredAt`
 * son inyectables para tests deterministas.
 */

interface EnvelopeOptions {
  operationId?: string;
  occurredAt?: string;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** "a, b , ,c" → ['a', 'b', 'c'] con el tope de 20 términos del contrato. */
export function parseTermList(value: string): string[] {
  return value
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 20);
}

function cleanTerms(terms: string[] | undefined): string[] | undefined {
  const cleaned = terms?.map((term) => term.trim()).filter((term) => term.length > 0);
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

export function createWikiSpace(
  input: { householdId: string; name: string; slug?: string; description?: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<WikiSpaceCreatePayloadV1> {
  const slug = trimmedOrUndefined(input.slug);
  const description = trimmedOrUndefined(input.description);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'wiki_space',
    payload: {
      action: 'create',
      name: input.name.trim(),
      ...(slug ? { slug } : {}),
      ...(description ? { description } : {})
    } satisfies WikiSpaceCreatePayloadV1
  }) as CommandEnvelopeV1<WikiSpaceCreatePayloadV1>;
}

/**
 * Payloads congelados de `wiki_space`/set_template y clone_template. El
 * contrato zod (`wikiSpaceCommandPayloadSchema`) no expone interfaces V1
 * dedicadas, así que las formas viven aquí y los tests las validan contra el
 * schema congelado.
 */
export interface WikiSpaceSetTemplatePayload {
  action: 'set_template';
  spaceId: string;
  isTemplate: boolean;
}

export interface WikiSpaceClonePayload {
  action: 'clone_template';
  templateSpaceId: string;
  name: string;
  slug?: string;
}

/** Marca o desmarca un espacio como plantilla clonable (solo familia). */
export function setWikiSpaceTemplate(
  input: { householdId: string; spaceId: string; isTemplate: boolean },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<WikiSpaceSetTemplatePayload> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'wiki_space',
    aggregateId: input.spaceId,
    payload: {
      action: 'set_template',
      spaceId: input.spaceId,
      isTemplate: input.isTemplate
    } satisfies WikiSpaceSetTemplatePayload
  }) as CommandEnvelopeV1<WikiSpaceSetTemplatePayload>;
}

/**
 * Espacio nuevo clonado desde una plantilla del MISMO hogar: el servidor copia
 * la jerarquía completa de páginas y reescribe los enlaces internos.
 */
export function cloneWikiTemplate(
  input: { householdId: string; templateSpaceId: string; name: string; slug?: string },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<WikiSpaceClonePayload> {
  const slug = trimmedOrUndefined(input.slug);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'wiki_space',
    payload: {
      action: 'clone_template',
      templateSpaceId: input.templateSpaceId,
      name: input.name.trim(),
      ...(slug ? { slug } : {})
    } satisfies WikiSpaceClonePayload
  }) as CommandEnvelopeV1<WikiSpaceClonePayload>;
}

/**
 * Nota nueva. El apartado va por identificador (`spaceId`) cuando ya existe o
 * por slug (`spaceSlug` + `spaceName`) cuando el hogar todavía no lo tiene: en
 * ese caso el propio comando lo da de alta en el servidor, así que la primera
 * instrucción de la Guía se puede escribir SIN conexión.
 */
export function createWikiPage(
  input: {
    householdId: string;
    spaceId?: string;
    spaceSlug?: string;
    spaceName?: string;
    parentPageId?: string | null;
    title: string;
    bodyMarkdown: string;
    tags?: string[];
    aliases?: string[];
    publish?: boolean;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<WikiPageCreatePayloadV1> {
  const tags = cleanTerms(input.tags);
  const aliases = cleanTerms(input.aliases);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'wiki_page',
    payload: {
      action: 'create',
      ...(input.spaceId
        ? { spaceId: input.spaceId }
        : {
            spaceSlug: input.spaceSlug ?? '',
            ...(input.spaceName ? { spaceName: input.spaceName } : {})
          }),
      ...(input.parentPageId ? { parentPageId: input.parentPageId } : {}),
      title: input.title.trim(),
      bodyMarkdown: input.bodyMarkdown,
      ...(tags ? { tags } : {}),
      ...(aliases ? { aliases } : {}),
      ...(input.publish ? { publish: true } : {})
    } satisfies WikiPageCreatePayloadV1
  }) as CommandEnvelopeV1<WikiPageCreatePayloadV1>;
}

/**
 * Nueva revisión de una página. `baseRevision` es la revisión mostrada al
 * empezar la edición: viaja en el envelope (no en el payload) para que el
 * servidor detecte conflictos y los resuelva una persona, nunca un merge.
 */
export function editWikiPage(
  input: {
    householdId: string;
    pageId: string;
    baseRevision: number;
    title: string;
    bodyMarkdown: string;
    summary?: string;
    tags?: string[];
    aliases?: string[];
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<WikiPageEditPayloadV1> {
  const summary = trimmedOrUndefined(input.summary);
  const tags = cleanTerms(input.tags);
  const aliases = cleanTerms(input.aliases);
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'wiki_page',
    aggregateId: input.pageId,
    baseRevision: input.baseRevision,
    payload: {
      action: 'edit',
      pageId: input.pageId,
      title: input.title.trim(),
      bodyMarkdown: input.bodyMarkdown,
      ...(summary ? { summary } : {}),
      ...(tags ? { tags } : {}),
      ...(aliases ? { aliases } : {})
    } satisfies WikiPageEditPayloadV1
  }) as CommandEnvelopeV1<WikiPageEditPayloadV1>;
}

export function setWikiPageState(
  input: {
    householdId: string;
    pageId: string;
    status?: 'draft' | 'published';
    pinned?: boolean;
  },
  options: EnvelopeOptions = {}
): CommandEnvelopeV1<WikiPageSetStatePayloadV1> {
  return createCommandEnvelope({
    ...options,
    householdId: input.householdId,
    aggregateType: 'wiki_page',
    aggregateId: input.pageId,
    payload: {
      action: 'set_state',
      pageId: input.pageId,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {})
    } satisfies WikiPageSetStatePayloadV1
  }) as CommandEnvelopeV1<WikiPageSetStatePayloadV1>;
}

export type { QueueOutcome };

/**
 * Delegado del encolado unificado (`$lib/offline/queue-command`): conserva la
 * firma histórica devolviendo solo el outcome ('synced' | 'queued' |
 * 'rejected' | 'conflict'). Para el mensaje veraz completo (causa traducida de
 * un rejected/conflict) llama a `queueCommand` directamente.
 */
export async function queueWikiCommand(envelope: CommandEnvelopeV1): Promise<QueueOutcome> {
  return (await queueCommand(envelope)).outcome;
}
