import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { products as bundledProducts, type Product } from "../data/products";
import { loadCatalogFromStorage } from "./storefrontStorage";

export type { Product };

/* -------------------------------------------------------------------------- */
/* Credenciais e cliente                                                      */
/* -------------------------------------------------------------------------- */

const PRODUCTS_TABLE = "products";
const PRODUCTS_CACHE_KEY = "tche-supabase-products-cache";

function readEnv(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const SUPABASE_URL = readEnv(import.meta.env.PUBLIC_SUPABASE_URL);
const SUPABASE_ANON_KEY = readEnv(import.meta.env.PUBLIC_SUPABASE_ANON_KEY);

/**
 * Só consideramos o Supabase configurado quando a URL é http(s) válida e a
 * chave anon tem tamanho plausível. Assim, builds sem `.env`, placeholders do
 * `.env.example` ou valores corrompidos caem no catálogo local em vez de
 * derrubar a aplicação.
 */
export const isSupabaseConfigured: boolean =
  /^https?:\/\/[^\s]+$/i.test(SUPABASE_URL) &&
  SUPABASE_ANON_KEY.length > 20 &&
  !/your-project|your-anon-key|placeholder/i.test(SUPABASE_URL) &&
  !/your-anon-key|placeholder/i.test(SUPABASE_ANON_KEY);

export class SupabaseUnavailableError extends Error {
  constructor(
    message = "Supabase não configurado. Defina PUBLIC_SUPABASE_URL e PUBLIC_SUPABASE_ANON_KEY para habilitar a persistência remota."
  ) {
    super(message);
    this.name = "SupabaseUnavailableError";
  }
}

function buildClient(): SupabaseClient<Database> | null {
  if (!isSupabaseConfigured) return null;

  try {
    return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  } catch (error) {
    console.error("[supabase] Falha ao inicializar o cliente:", error);
    return null;
  }
}

/** Cliente tipado, ou `null` quando as credenciais não estão disponíveis. */
export const supabase: SupabaseClient<Database> | null = buildClient();

/** Cliente obrigatório para operações que não têm fallback local. */
export function getSupabaseClient(): SupabaseClient<Database> {
  if (!supabase) throw new SupabaseUnavailableError();
  return supabase;
}

/* -------------------------------------------------------------------------- */
/* Tipos do banco (tabela `products`)                                         */
/* -------------------------------------------------------------------------- */

export type ProductRow = {
  id: string;
  name: string;
  category: string;
  price: number;
  regular_price: number | null;
  rating: number | null;
  reviews: number | null;
  image: string | null;
  description: string | null;
  badge: string | null;
  featured: boolean | null;
  created_at?: string;
  updated_at?: string;
};

export type ProductInsert = {
  id: string;
  name: string;
  category: string;
  price: number;
  regular_price?: number | null;
  rating?: number;
  reviews?: number;
  image?: string;
  description?: string;
  badge?: string | null;
  featured?: boolean;
  updated_at?: string;
};

export type ProductUpdate = Partial<ProductInsert>;

export interface Database {
  public: {
    Tables: {
      products: {
        Row: ProductRow;
        Insert: ProductInsert;
        Update: ProductUpdate;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}

/** Entrada aceita por `createProduct` (id opcional, gerado se ausente). */
export type ProductInput = Partial<Omit<Product, "id">> & {
  name: string;
  id?: string;
};

/* -------------------------------------------------------------------------- */
/* Normalização e fallback local                                              */
/* -------------------------------------------------------------------------- */

function toNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** Converte uma linha do PostgREST no `Product` usado pelo storefront. */
export function toProduct(row: Partial<ProductRow> | null | undefined): Product {
  const source = row ?? {};

  return {
    id: String(source.id ?? ""),
    name: cleanText(source.name),
    category: cleanText(source.category, "Geral"),
    price: toNumber(source.price, 0),
    regular_price: toOptionalNumber(source.regular_price),
    rating: toNumber(source.rating, 5),
    reviews: toNumber(source.reviews, 0),
    image: cleanText(source.image, "/images/shop/cosmic-products.png"),
    description: cleanText(source.description),
    badge: cleanText(source.badge) || undefined,
    featured: Boolean(source.featured),
  };
}

function compareProducts(a: Product, b: Product): number {
  const idA = Number(a.id);
  const idB = Number(b.id);
  if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) {
    return idA - idB;
  }
  return a.id.localeCompare(b.id, "pt-BR", { numeric: true });
}

function readCache(): Product[] | null {
  if (typeof localStorage === "undefined") return null;

  try {
    const raw = localStorage.getItem(PRODUCTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Product[]) : null;
  } catch {
    return null;
  }
}

function writeCache(items: Product[]): void {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(items));
  } catch {
    // cache é otimização: falha de quota/privacidade não deve quebrar a leitura
  }
}

export function clearProductsCache(): void {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.removeItem(PRODUCTS_CACHE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Fallback defensivo, na ordem: cache da última leitura remota, catálogo
 * editado no painel (localStorage) e, por fim, os 228 produtos empacotados
 * em `src/data/products.ts`.
 */
export function getLocalProducts(): Product[] {
  const cached = readCache();
  if (cached) return cached.map((item) => toProduct(item as Partial<ProductRow>)).sort(compareProducts);

  const stored = loadCatalogFromStorage<Product>();
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.map(toProduct).sort(compareProducts);
  }

  return bundledProducts.map((product) => toProduct(product as Partial<ProductRow>));
}

/* -------------------------------------------------------------------------- */
/* Serviço de produtos                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Lista os produtos do Supabase ordenados por id. Qualquer falha (sem
 * credenciais, rede, RLS, resposta vazia) resulta no catálogo local.
 */
export async function getProducts(): Promise<Product[]> {
  const client = supabase;
  if (!client) return getLocalProducts();

  try {
    const { data, error } = await client
      .from(PRODUCTS_TABLE)
      .select("*")
      .order("id", { ascending: true });

    if (error) throw error;

    const items = (data ?? [])
      .map((row) => toProduct(row as ProductRow))
      .filter((product) => product.id !== "" && product.name !== "")
      // `id` é texto no banco: reordenamos numericamente para casar com o
      // catálogo local (ex.: 650 depois de 4009, não antes).
      .sort(compareProducts);

    if (items.length === 0) return getLocalProducts();

    writeCache(items);
    return items;
  } catch (error) {
    console.warn("[supabase] getProducts falhou; usando catálogo local.", error);
    return getLocalProducts();
  }
}

/** Sessão obrigatória para escrita (RLS exige usuário autenticado). */
async function requireClientWithSession(): Promise<SupabaseClient<Database>> {
  const client = getSupabaseClient();

  const { data, error } = await client.auth.getSession();
  if (error) throw error;

  if (!data.session) {
    throw new Error(
      "É necessário estar autenticado como administrador para alterar produtos."
    );
  }

  return client;
}

function generateProductId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildUpdatePatch(input: Partial<ProductInput>): ProductUpdate {
  const patch: ProductUpdate = {};

  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.category !== undefined) patch.category = input.category.trim() || "Geral";
  if (input.price !== undefined) patch.price = toNumber(input.price, 0);
  if (input.regular_price !== undefined) {
    patch.regular_price = input.regular_price === null ? null : toNumber(input.regular_price, 0);
  }
  if (input.rating !== undefined) patch.rating = toNumber(input.rating, 5);
  if (input.reviews !== undefined) patch.reviews = Math.max(0, Math.trunc(toNumber(input.reviews, 0)));
  if (input.image !== undefined) patch.image = cleanText(input.image, "/images/shop/cosmic-products.png");
  if (input.description !== undefined) patch.description = input.description;
  if (input.badge !== undefined) patch.badge = input.badge || null;
  if (input.featured !== undefined) patch.featured = Boolean(input.featured);

  patch.updated_at = new Date().toISOString();
  return patch;
}

/** Insere um produto usando a sessão autenticada. */
export async function createProduct(input: ProductInput): Promise<Product> {
  const client = await requireClientWithSession();
  const name = input.name?.trim();
  if (!name) throw new Error("O nome do produto é obrigatório.");

  const row: ProductInsert = {
    id: input.id?.trim() || generateProductId(),
    name,
    category: input.category?.trim() || "Geral",
    price: toNumber(input.price, 0),
    regular_price: input.regular_price === undefined || input.regular_price === null
      ? null
      : toNumber(input.regular_price, 0),
    rating: toNumber(input.rating, 5),
    reviews: Math.max(0, Math.trunc(toNumber(input.reviews, 0))),
    image: cleanText(input.image, "/images/shop/cosmic-products.png"),
    description: input.description ?? "",
    badge: input.badge || null,
    featured: Boolean(input.featured),
  };

  const { data, error } = await client
    .from(PRODUCTS_TABLE)
    .insert(row)
    .select("*")
    .single();

  if (error) throw new Error(`Falha ao criar produto: ${error.message}`);

  clearProductsCache();
  return toProduct(data as ProductRow);
}

/** Atualiza um produto existente; apenas os campos enviados são alterados. */
export async function updateProduct(id: string, input: Partial<ProductInput>): Promise<Product> {
  const client = await requireClientWithSession();
  const productId = id?.trim();
  if (!productId) throw new Error("Informe o id do produto a atualizar.");

  const patch = buildUpdatePatch(input);

  const { data, error } = await client
    .from(PRODUCTS_TABLE)
    .update(patch)
    .eq("id", productId)
    .select("*")
    .single();

  if (error) throw new Error(`Falha ao atualizar produto ${productId}: ${error.message}`);

  clearProductsCache();
  return toProduct(data as ProductRow);
}

/** Remove um produto e confirma que alguma linha foi afetada. */
export async function deleteProduct(id: string): Promise<boolean> {
  const client = await requireClientWithSession();
  const productId = id?.trim();
  if (!productId) throw new Error("Informe o id do produto a remover.");

  const { data, error } = await client
    .from(PRODUCTS_TABLE)
    .delete()
    .eq("id", productId)
    .select("id");

  if (error) throw new Error(`Falha ao remover produto ${productId}: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("Produto não encontrado ou sem permissão para removê-lo.");
  }

  clearProductsCache();
  return true;
}

/* -------------------------------------------------------------------------- */
/* Autenticação                                                               */
/* -------------------------------------------------------------------------- */

export interface AuthResult {
  session: Session | null;
  user: User | null;
  error: Error | null;
}

function authError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const client = supabase;
  if (!client) {
    return { session: null, user: null, error: new SupabaseUnavailableError() };
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    return {
      session: data.session ?? null,
      user: data.user ?? null,
      error: error ? authError(error) : null,
    };
  } catch (error) {
    return { session: null, user: null, error: authError(error) };
  }
}

export async function signOut(): Promise<{ error: Error | null }> {
  const client = supabase;
  if (!client) return { error: new SupabaseUnavailableError() };

  try {
    const { error } = await client.auth.signOut();
    return { error: error ? authError(error) : null };
  } catch (error) {
    return { error: authError(error) };
  }
}

export async function getCurrentSession(): Promise<Session | null> {
  const client = supabase;
  if (!client) return null;

  try {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session ?? null;
  } catch (error) {
    console.warn("[supabase] getCurrentSession falhou.", error);
    return null;
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}

export type AuthStateCallback = (event: AuthChangeEvent, session: Session | null) => void;

/**
 * Assina mudanças de autenticação e devolve a função de cancelamento.
 * Sem Supabase configurado, retorna um no-op para o chamador não precisar
 * tratar o caso.
 */
export function onAuthStateChange(callback: AuthStateCallback): () => void {
  const client = supabase;
  if (!client) return () => {};

  const { data } = client.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });

  return () => data.subscription.unsubscribe();
}
