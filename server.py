import http.server
import socketserver
import json
import os
import sys
import threading
import time
import requests
import shutil
import urllib.request
import urllib.parse
import urllib.error
from bisect import bisect_left, bisect_right
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
os.environ["CURL_CA_BUNDLE"] = ""
os.environ["REQUESTS_CA_BUNDLE"] = ""

# Ensure UTF-8 on Windows stdout
if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Setup Directories
MONITOR_APP_DIR = os.environ.get(
    "MONITOR_APP_DIR",
    os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
)
PEDIDOS_DIR = os.path.join(MONITOR_APP_DIR, "app_pedidos")
CHAMADOS_DIR = os.path.join(MONITOR_APP_DIR, "app_chamados")
MONITOR_DATA_DIR = os.environ.get("MONITOR_DATA_DIR", MONITOR_APP_DIR)
PEDIDOS_DATA_DIR = os.path.join(MONITOR_DATA_DIR, "app_pedidos")
CHAMADOS_DATA_DIR = os.path.join(MONITOR_DATA_DIR, "app_chamados")

# Ensure directories exist
os.makedirs(PEDIDOS_DIR, exist_ok=True)
os.makedirs(CHAMADOS_DIR, exist_ok=True)
os.makedirs(PEDIDOS_DATA_DIR, exist_ok=True)
os.makedirs(CHAMADOS_DATA_DIR, exist_ok=True)

def migrate_legacy_data(source_dir, target_dir, file_names):
    if os.path.abspath(source_dir) == os.path.abspath(target_dir):
        return
    for file_name in file_names:
        source = os.path.join(source_dir, file_name)
        target = os.path.join(target_dir, file_name)
        if os.path.exists(source) and not os.path.exists(target):
            try:
                shutil.copy2(source, target)
                print(f"[INFO] Dado local migrado: {file_name}")
            except Exception as err:
                print(f"[WARN] Falha ao migrar {file_name}: {err}")

migrate_legacy_data(PEDIDOS_DIR, PEDIDOS_DATA_DIR, (
    "pedidos_state.json", "pedidos_state.json.bak",
    "notificacoes.json", "notificacoes.json.bak",
    "preferencias_notificacoes.json", "preferencias_notificacoes.json.bak"
))
migrate_legacy_data(CHAMADOS_DIR, CHAMADOS_DATA_DIR, (
    "chamados_state.json", "chamados_state.json.bak",
    "notificacoes.json", "notificacoes.json.bak",
    "notificacoes_chamados.json", "notificacoes_chamados.json.bak",
    "preferencias_notificacoes.json", "preferencias_notificacoes.json.bak"
))

# State & Notifications Files
PEDIDOS_STATE_FILE = os.path.join(PEDIDOS_DATA_DIR, "pedidos_state.json")
PEDIDOS_NOTIFICATIONS_FILE = os.path.join(PEDIDOS_DATA_DIR, "notificacoes.json")
CHAMADOS_STATE_FILE = os.path.join(CHAMADOS_DATA_DIR, "chamados_state.json")
CHAMADOS_NOTIFICATIONS_FILE = os.path.join(CHAMADOS_DATA_DIR, "notificacoes.json")
PEDIDOS_PREFS_FILE = os.path.join(PEDIDOS_DATA_DIR, "preferencias_notificacoes.json")
CHAMADOS_PREFS_FILE = os.path.join(CHAMADOS_DATA_DIR, "preferencias_notificacoes.json")

PEDIDOS_DEFAULT_PREFS = {
    "enableNative": False,
    "enableSound": True,
    "statusRules": {}
}
CHAMADOS_DEFAULT_PREFS = {
    "enableNative": False,
    "enableSound": True,
    "ruleNew": True,
    "ruleStatus": True,
    "ruleReply": True,
    "ruleCategory": True,
    "ruleAttendant": True,
    "attendantFilters": [],
    "categoryFilters": []
}

# API Configuration
PORT = int(os.environ.get("PORT", 8080))
POLL_INTERVAL_SECONDS = 120
API_WORKERS = 6
NOTIFICATION_HISTORY_LIMIT = 5000

response_cache_lock = threading.Lock()
response_cache = {}

def cached_json_bytes(cache_key, revision, producer):
    with response_cache_lock:
        cached = response_cache.get(cache_key)
        if cached and cached[0] == revision:
            return cached[1]

    payload = json.dumps(producer(), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with response_cache_lock:
        response_cache[cache_key] = (revision, payload)
    return payload

# Pedidos Constants
PEDIDOS_RECENT_POLL_DAYS = 3
PEDIDOS_STARTUP_REFRESH_DAYS = 7
PEDIDOS_INITIAL_IMPORT_DAYS = 90
PEDIDOS_MANUAL_REFRESH_DAYS = 7
PEDIDOS_DEEP_REFRESH_DAYS = 60
PEDIDOS_DEEP_REFRESH_INTERVAL_SECONDS = 6 * 60 * 60
PEDIDOS_ACTIVE_ORDER_DATE_BATCH_SIZE = 14

# Chamados Constants
TICKETS_LOOKBACK_DAYS = 120
TICKETS_RECENT_LOOKBACK_DAYS = 7
TICKETS_PAGE_STEP = 20
DETAIL_REFRESH_SECONDS = 1800
FULL_SYNC_INTERVAL_SECONDS = 3 * 3600
FEEDBACK_SYNC_VERSION = "1.0"

# Load API token
ENV_PATHS = [
    os.path.join(MONITOR_APP_DIR, ".env"),
    os.path.join(os.path.dirname(MONITOR_APP_DIR), ".env"),
    os.path.join(os.path.dirname(MONITOR_APP_DIR), "teste_api_central", ".env")
]

def load_token():
    for path in ENV_PATHS:
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#'):
                            key, val = line.split('=', 1)
                            if key.strip() == "CENTRAL_TOKEN":
                                print(f"[INFO] Token carregado de {path}")
                                return val.strip()
            except Exception as e:
                print(f"[WARN] Erro ao ler {path}: {e}")
    return None

TOKEN = load_token()
if not TOKEN:
    print("[ERROR] CENTRAL_TOKEN nao encontrado em nenhum arquivo .env!")

# Shared Helper to load/save JSON
def load_json_file(path, default):
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[WARN] Erro ao carregar {path}: {e}")
            backup_path = f"{path}.bak"
            if os.path.exists(backup_path):
                try:
                    with open(backup_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        print(f"[INFO] Restaurado com sucesso do backup: {backup_path}")
                        return data
                except Exception as be:
                    print(f"[WARN] Erro ao carregar backup {backup_path}: {be}")
    return default

def save_json_file(path, data):
    temp_path = f"{path}.tmp"
    backup_path = f"{path}.bak"
    try:
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        if os.path.exists(path):
            try:
                shutil.copyfile(path, backup_path)
            except Exception:
                pass
        os.replace(temp_path, path)
    except Exception as e:
        print(f"[ERROR] Erro ao salvar {path}: {e}")
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass

def save_compact_json_file(path, data):
    temp_path = f"{path}.tmp"
    backup_path = f"{path}.bak"
    try:
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, separators=(",", ":"))
        if os.path.exists(path):
            try:
                shutil.copyfile(path, backup_path)
            except Exception:
                pass
        os.replace(temp_path, path)
    except Exception as error:
        print(f"[ERROR] Erro ao salvar cache compacto {path}: {error}")
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass

def now_iso():
    return datetime.now().isoformat()

# ==============================================================================
# PEDIDOS ENGINE
# ==============================================================================

pedidos_state_lock = threading.Lock()
pedidos_sync_lock = threading.Lock()
pedidos_sync_status = {
    "is_syncing": False,
    "phase": "",
    "startedAt": None,
    "finishedAt": None
}
pedidos_data_revision = 0

def set_pedidos_sync_status(is_syncing, phase="sincronizando dados"):
    pedidos_sync_status.update({
        "is_syncing": is_syncing,
        "phase": phase if is_syncing else "",
        "startedAt": now_iso() if is_syncing else pedidos_sync_status.get("startedAt"),
        "finishedAt": None if is_syncing else now_iso()
    })

def poll_orders_dates(date_strings, label=None):
    if not TOKEN:
        print("[ERROR] Sem token para fazer requisicao a API.")
        return False

    url = "https://app.centraldofranqueado.com.br/api/v2/pedidos/"
    headers = {
        "x-api-key": TOKEN,
        "Content-Type": "application/json"
    }

    unique_dates = sorted(set(date_strings), reverse=True)
    if not unique_dates:
        return False

    label = label or f"{len(unique_dates)} datas"
    print(f"[PEDIDOS API] Iniciando busca de pedidos: {label}...")

    def fetch_date(date_str):
        try:
            response = requests.get(url, headers=headers, params={'periodo': date_str}, timeout=15, verify=False)
            if response.status_code == 200:
                day_orders = response.json()
                if isinstance(day_orders, list):
                    return day_orders
                else:
                    print(f"[PEDIDOS API] Resposta para {date_str} nao e uma lista.")
            else:
                print(f"[PEDIDOS API] Erro em {date_str}: Status {response.status_code}")
        except Exception as e:
            print(f"[PEDIDOS API] Excecao em {date_str}: {e}")
        return []

    fetched_by_id = {}
    with ThreadPoolExecutor(max_workers=min(API_WORKERS, len(unique_dates))) as executor:
        futures = [executor.submit(fetch_date, date_str) for date_str in unique_dates]
        for future in as_completed(futures):
            for order in future.result():
                oid = order.get("_id")
                if oid:
                    fetched_by_id[oid] = order

    if fetched_by_id:
        process_pedidos_poll_data(list(fetched_by_id.values()))
        return True

    print("[PEDIDOS API] Nenhum pedido retornado na varredura.")
    return False

def poll_orders_range(days):
    date_strings = [(datetime.now() - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days)]
    return poll_orders_dates(date_strings, f"ultimos {days} dias")

def is_inactive_order(order):
    situacao = order.get("situacao", {})
    is_final = situacao.get("isSituacaoFinal", False)
    is_cancel = situacao.get("isCancelamento", False)
    status_desc = situacao.get("descricao", "").lower()
    status_code = situacao.get("status", "").lower()

    return (
        is_final or
        is_cancel or
        "entregue" in status_desc or
        "finalizado" in status_desc or
        "cancelado" in status_desc or
        "entregue" in status_code or
        "finalizado" in status_code or
        "cancelado" in status_code
    )

def get_order_creation_date(order):
    raw_date = order.get("dataCriacao") or order.get("createdAt")
    if not raw_date:
        return None
    return str(raw_date)[:10]

def get_active_order_creation_dates():
    with pedidos_state_lock:
        cached_orders = load_json_file(PEDIDOS_STATE_FILE, {})

    dates = set()
    for order in cached_orders.values():
        if not is_inactive_order(order):
            creation_date = get_order_creation_date(order)
            if creation_date:
                dates.add(creation_date)
    return sorted(dates)

def pick_rotating_batch(items, cursor, size):
    if not items:
        return [], 0

    cursor = cursor % len(items)
    batch = []
    for i in range(min(size, len(items))):
        batch.append(items[(cursor + i) % len(items)])
    return batch, (cursor + len(batch)) % len(items)

def run_pedidos_startup_full_sync(cache_is_empty):
    set_pedidos_sync_status(True, "sincronizando dados")
    try:
        if cache_is_empty:
            poll_orders_range(PEDIDOS_INITIAL_IMPORT_DAYS)
        else:
            poll_orders_range(PEDIDOS_DEEP_REFRESH_DAYS)
            active_dates = get_active_order_creation_dates()
            poll_orders_dates(active_dates, f"{len(active_dates)} datas com pedidos ativos")
    finally:
        set_pedidos_sync_status(False)

def process_pedidos_poll_data(current_orders):
    global pedidos_data_revision
    with pedidos_state_lock:
        prev_state = load_json_file(PEDIDOS_STATE_FILE, {})
        notifications = load_json_file(PEDIDOS_NOTIFICATIONS_FILE, [])

        current_by_id = {o["_id"]: o for o in current_orders if "_id" in o}
        updated_state = prev_state.copy()

        changes_detected = False
        data_changed = False
        new_notifications = []

        for oid, order in current_by_id.items():
            if prev_state.get(oid) != order:
                data_changed = True
            code = order.get("codigo", "S/N")
            supplier = order.get("fornecedor", {}).get("nome", "Fornecedor Desconhecido")
            franchise = order.get("franqueado", {}).get("nome", "Franquia Desconhecida")
            
            curr_status = order.get("situacao", {}).get("descricao", "Sem status")
            curr_status_code = order.get("situacao", {}).get("status", "")

            if oid in prev_state:
                prev_order = prev_state[oid]
                prev_status = prev_order.get("situacao", {}).get("descricao", "Sem status")
                prev_status_code = prev_order.get("situacao", {}).get("status", "")

                if curr_status != prev_status or curr_status_code != prev_status_code:
                    msg = f"Pedido #{code} ({supplier} -> {franchise}) teve a situação alterada de '{prev_status}' para '{curr_status}'."
                    print(f"[PEDIDOS NOTIFICATION] {msg}")

                    new_notifications.append({
                        "id": f"{oid}_{int(time.time())}",
                        "timestamp": order.get("situacao", {}).get("dataAlteracao") or order.get("updatedAt") or datetime.now().isoformat(),
                        "order_id": oid,
                        "codigo": code,
                        "fornecedor": supplier,
                        "franqueado": franchise,
                        "tipo": "alteracao_status",
                        "status_anterior": prev_status,
                        "status_atual": curr_status,
                        "mensagem": msg
                    })
                    changes_detected = True
            else:
                msg = f"Novo pedido #{code} criado para {supplier} (Franquia: {franchise}) com situação '{curr_status}'."
                print(f"[PEDIDOS NOTIFICATION] {msg}")
                new_notifications.append({
                    "id": f"{oid}_{int(time.time())}",
                    "timestamp": order.get("dataCriacao") or order.get("createdAt") or datetime.now().isoformat(),
                    "order_id": oid,
                    "codigo": code,
                    "fornecedor": supplier,
                    "franqueado": franchise,
                    "tipo": "novo_pedido",
                    "status_anterior": None,
                    "status_atual": curr_status,
                    "mensagem": msg
                })
                changes_detected = True

            updated_state[oid] = order

        if changes_detected:
            notifications = new_notifications + notifications
            notifications.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
            notifications = notifications[:NOTIFICATION_HISTORY_LIMIT]
            save_json_file(PEDIDOS_NOTIFICATIONS_FILE, notifications)

        if data_changed:
            save_json_file(PEDIDOS_STATE_FILE, updated_state)
            pedidos_data_revision += 1
        print(f"[PEDIDOS STATE] Cache atualizado. {len(updated_state)} pedidos em cache.")

def pedidos_poll_loop():
    print("[PEDIDOS THREAD] Polling thread iniciada.")
    active_date_cursor = 0
    
    cached = load_json_file(PEDIDOS_STATE_FILE, {})
    if not cached:
        print(f"[PEDIDOS INIT] Cache local vazio! Importando {PEDIDOS_INITIAL_IMPORT_DAYS} dias...")
        with pedidos_sync_lock:
            run_pedidos_startup_full_sync(True)
        last_deep_sync = time.time()
    else:
        print(f"[PEDIDOS INIT] Cache carregado com {len(cached)} pedidos. Fazendo sync de inicializacao...")
        with pedidos_sync_lock:
            run_pedidos_startup_full_sync(False)
        last_deep_sync = time.time()

    while True:
        time.sleep(POLL_INTERVAL_SECONDS)
        with pedidos_sync_lock:
            set_pedidos_sync_status(True, "sincronizando dados")
            try:
                poll_orders_range(PEDIDOS_RECENT_POLL_DAYS)
                active_dates = get_active_order_creation_dates()
                active_batch, active_date_cursor = pick_rotating_batch(
                    active_dates,
                    active_date_cursor,
                    PEDIDOS_ACTIVE_ORDER_DATE_BATCH_SIZE
                )
                poll_orders_dates(active_batch, f"lote de {len(active_batch)} datas com pedidos ativos antigos")
                if time.time() - last_deep_sync >= PEDIDOS_DEEP_REFRESH_INTERVAL_SECONDS:
                    poll_orders_range(PEDIDOS_DEEP_REFRESH_DAYS)
                    last_deep_sync = time.time()
            except Exception as e:
                print(f"[PEDIDOS ERROR] Falha no loop de sync: {e}")
            finally:
                set_pedidos_sync_status(False)

# ==============================================================================
# CHAMADOS ENGINE
# ==============================================================================

chamados_state_lock = threading.Lock()
chamados_sync_lock = threading.Lock()
chamados_sync_status = {
    "is_syncing": False,
    "phase": "",
    "startedAt": None,
    "finishedAt": None
}
chamados_data_revision = 0

def set_chamados_sync_status(is_syncing, phase="sincronizando dados"):
    chamados_sync_status.update({
        "is_syncing": is_syncing,
        "phase": phase if is_syncing else "",
        "startedAt": now_iso() if is_syncing else chamados_sync_status.get("startedAt"),
        "finishedAt": None if is_syncing else now_iso()
    })

def query_central_api(path, params=None):
    if not TOKEN:
        print("[ERROR] Sem token para fazer requisicao a API.")
        return None

    url = f"https://app.centraldofranqueado.com.br/api/v3{path}"
    if params:
        query_str = urllib.parse.urlencode(params)
        url = f"{url}?{query_str}"
        
    req = urllib.request.Request(
        url,
        headers={
            'x-api-key': TOKEN,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print(f"[CHAMADOS API ERROR] HTTP {e.code} ao chamar {url}: {e.read().decode('utf-8', errors='ignore')}")
    except Exception as e:
        print(f"[CHAMADOS API ERROR] Falha ao conectar em {url}: {e}")
    return None

def normalize_text(value):
    if not value:
        return ''
    return str(value).strip().lower()

def ticket_status_texts(ticket):
    status = normalize_text(ticket.get('status'))
    custom_status = normalize_text(ticket.get('customStatus', {}).get('description'))
    return status, custom_status

def is_finished_or_waiting_feedback(ticket):
    status, custom_status = ticket_status_texts(ticket)
    return (
        status == 'finished' or 
        status == 'awaitingfeedback' or 
        'finalizado' in custom_status or 
        'concluido' in custom_status or 
        'concluído' in custom_status
    )

def is_monitorable_ticket(ticket):
    return not is_finished_or_waiting_feedback(ticket)

def parse_api_datetime(value):
    if not value:
        return None
    try:
        value = str(value).replace('Z', '+00:00')
        return datetime.fromisoformat(value)
    except Exception:
        return None

def utc_now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def seconds_since(value):
    if not value:
        return None
    dt = parse_api_datetime(value)
    if not dt:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds()

def get_ticket_category_name(ticket):
    return ticket.get('category', {}).get('name', 'Sem Categoria')

def get_ticket_category_id(ticket):
    return ticket.get('category', {}).get('_id')

def get_ticket_attendant_key(ticket):
    return ticket.get('attendantId') or 'unassigned'

def get_ticket_attendant_name(ticket):
    return ticket.get('attendantName') or ticket.get('attendant', {}).get('name') or 'Sem Atendente'

def fetch_all_tickets_from_api(lookback_days=TICKETS_LOOKBACK_DAYS):
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

    def fetch_ticket_stream(is_internal):
        stream_items = []
        skip = 0
        empty_pages = 0
        while True:
            params = {
                'internalTickets': 'true' if is_internal else 'false',
                'skipCount': skip
            }
            res = query_central_api('/tickets', params)
            if not res or not isinstance(res, list):
                break
            
            new_items = 0
            oldest_created_at = None
            for item in res:
                created_at = parse_api_datetime(item.get('createdAt'))
                if created_at and created_at < cutoff:
                    if oldest_created_at is None or created_at < oldest_created_at:
                        oldest_created_at = created_at
                    continue

                oid = item.get('_id')
                if oid:
                    stream_items.append(item)
                    new_items += 1

                if created_at and (oldest_created_at is None or created_at < oldest_created_at):
                    oldest_created_at = created_at

            if new_items == 0:
                empty_pages += 1
            else:
                empty_pages = 0

            if empty_pages >= 3:
                break

            if oldest_created_at and oldest_created_at < cutoff:
                break

            skip += TICKETS_PAGE_STEP
        return stream_items

    tickets_by_id = {}
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(fetch_ticket_stream, is_internal) for is_internal in (False, True)]
        for future in as_completed(futures):
            for ticket in future.result():
                oid = ticket.get('_id')
                if oid:
                    tickets_by_id[oid] = ticket

    tickets_list = list(tickets_by_id.values())
    print(f"[CHAMADOS SYNC] Baixadas {len(tickets_list)} referencias de chamados.")
    return tickets_list

def ticket_needs_detail(item, cached_item, detail_refresh_seconds, collect_feedback):
    status = item.get('status', 'open')
    is_inactive = is_finished_or_waiting_feedback(item)
    detail_age = seconds_since(cached_item.get('_detailSyncedAt')) if cached_item else None
    has_detail = cached_item is not None and bool(cached_item.get('_detailSyncedAt'))
    detail_is_stale = (
        detail_refresh_seconds is not None and
        (detail_age is None or detail_age >= detail_refresh_seconds)
    )
    feedback = cached_item.get('feedback') if cached_item else None
    feedback_synced = cached_item.get('_feedbackSyncedAt') if cached_item else None
    feedback_sync_version = cached_item.get('_feedbackSyncVersion') if cached_item else None
    cached_status = normalize_text(cached_item.get('status')) if cached_item else ''
    current_status = normalize_text(status)
    is_feedback_pending = current_status == 'awaitingfeedback' or cached_status == 'awaitingfeedback'
    needs_feedback_refresh = (
        collect_feedback and is_inactive and (
            not cached_item or
            not feedback_synced or
            feedback_sync_version != FEEDBACK_SYNC_VERSION or
            cached_item.get('status') != status or
            not isinstance(feedback, dict) or
            is_feedback_pending
        )
    )
    return (
        is_monitorable_ticket(item) and (
            not has_detail or cached_item.get('status') != status or detail_is_stale
        )
    ) or needs_feedback_refresh

def public_ticket_data(ticket):
    return {key: value for key, value in ticket.items() if not key.startswith('_')}

def sync_tickets_data(full_import=False, lookback_days=TICKETS_RECENT_LOOKBACK_DAYS, detail_refresh_seconds=DETAIL_REFRESH_SECONDS, collect_feedback=False):
    global chamados_data_revision
    print("[CHAMADOS SYNC] Iniciando sincronizacao de chamados...")
    
    with chamados_state_lock:
        cached_tickets = load_json_file(CHAMADOS_STATE_FILE, {})
    notifications = load_json_file(CHAMADOS_NOTIFICATIONS_FILE, [])
    
    attendant_names = {}
    for t_id, ticket in cached_tickets.items():
        for ans in ticket.get('answers', []):
            u_id = ans.get('userId')
            u_name = ans.get('username')
            if u_id and u_name:
                attendant_names[u_id] = u_name
                
    api_list = fetch_all_tickets_from_api(lookback_days=lookback_days)
    if not api_list:
        print("[CHAMADOS SYNC] Nenhum chamado retornado da API. Cancelando sync.")
        return False
        
    updated_state = cached_tickets.copy()
    new_notifications = []
    changes_detected = False

    detail_items = [
        item for item in api_list
        if item.get('_id') and ticket_needs_detail(
            item,
            cached_tickets.get(item.get('_id')),
            detail_refresh_seconds,
            collect_feedback
        )
    ]
    details_by_id = {}

    def fetch_ticket_detail(item):
        oid = item.get('_id')
        print(f"[CHAMADOS SYNC] Buscando detalhes do chamado #{item.get('code')} ({oid})...")
        detail = query_central_api(f"/tickets/{oid}")
        if detail:
            detail['_detailSyncedAt'] = utc_now_iso()
            if is_finished_or_waiting_feedback(detail):
                detail['_feedbackSyncedAt'] = utc_now_iso()
                detail['_feedbackSyncVersion'] = FEEDBACK_SYNC_VERSION
        return oid, detail

    if detail_items:
        with ThreadPoolExecutor(max_workers=min(API_WORKERS, len(detail_items))) as executor:
            futures = [executor.submit(fetch_ticket_detail, item) for item in detail_items]
            for future in as_completed(futures):
                oid, detail = future.result()
                if detail:
                    details_by_id[oid] = detail
    
    for item in api_list:
        oid = item.get('_id')
        if not oid:
            continue
            
        cached_item = cached_tickets.get(oid)
        ticket_detail = details_by_id.get(oid)
        if not ticket_detail:
            ticket_detail = {**cached_item, **item} if cached_item else item
            
        for ans in ticket_detail.get('answers', []):
            u_id = ans.get('userId')
            u_name = ans.get('username')
            if u_id and u_name:
                attendant_names[u_id] = u_name
                
        att_id = ticket_detail.get('attendantId')
        if att_id and att_id in attendant_names:
            ticket_detail['attendantName'] = attendant_names[att_id]
        else:
            ticket_detail['attendantName'] = None
            
        if cached_item:
            old_status = cached_item.get('status')
            new_status = ticket_detail.get('status')
            if old_status != new_status:
                status_labels = {'open': 'Aberto', 'inAttendance': 'Em Atendimento', 'finished': 'Finalizado'}
                lbl_old = status_labels.get(old_status, old_status)
                lbl_new = status_labels.get(new_status, new_status)
                
                ts = ticket_detail.get('updatedAt') or datetime.utcnow().isoformat() + 'Z'
                new_notifications.append({
                    "id": f"{oid}_status_{int(time.time())}",
                    "timestamp": ts,
                    "ticket_id": oid,
                    "code": ticket_detail.get('code'),
                    "tipo": "alteracao_status",
                    "status_anterior": old_status,
                    "status_atual": new_status,
                    "categoria_atual": get_ticket_category_name(ticket_detail),
                    "categoria_atual_id": get_ticket_category_id(ticket_detail),
                    "atendente_atual": get_ticket_attendant_name(ticket_detail),
                    "attendant_id": ticket_detail.get('attendantId'),
                    "mensagem": f"Chamado #{ticket_detail.get('code')} ({ticket_detail.get('subject')}) teve a situação alterada de '{lbl_old}' para '{lbl_new}'."
                })
                changes_detected = True

            old_category_id = get_ticket_category_id(cached_item)
            new_category_id = get_ticket_category_id(ticket_detail)
            if old_category_id != new_category_id:
                old_category_name = get_ticket_category_name(cached_item)
                new_category_name = get_ticket_category_name(ticket_detail)
                ts = ticket_detail.get('updatedAt') or datetime.utcnow().isoformat() + 'Z'
                new_notifications.append({
                    "id": f"{oid}_category_{int(time.time())}",
                    "timestamp": ts,
                    "ticket_id": oid,
                    "code": ticket_detail.get('code'),
                    "tipo": "alteracao_categoria",
                    "categoria_anterior": old_category_name,
                    "categoria_atual": new_category_name,
                    "categoria_atual_id": new_category_id,
                    "atendente_atual": get_ticket_attendant_name(ticket_detail),
                    "attendant_id": ticket_detail.get('attendantId'),
                    "mensagem": f"Chamado #{ticket_detail.get('code')} mudou de categoria de '{old_category_name}' para '{new_category_name}'."
                })
                changes_detected = True

            old_attendant_key = get_ticket_attendant_key(cached_item)
            new_attendant_key = get_ticket_attendant_key(ticket_detail)
            if old_attendant_key != new_attendant_key:
                old_attendant_name = get_ticket_attendant_name(cached_item)
                new_attendant_name = get_ticket_attendant_name(ticket_detail)
                ts = ticket_detail.get('updatedAt') or datetime.utcnow().isoformat() + 'Z'
                new_notifications.append({
                    "id": f"{oid}_attendant_{int(time.time())}",
                    "timestamp": ts,
                    "ticket_id": oid,
                    "code": ticket_detail.get('code'),
                    "tipo": "alteracao_atendente",
                    "atendente_anterior": old_attendant_name,
                    "atendente_atual": new_attendant_name,
                    "attendant_id": ticket_detail.get('attendantId'),
                    "categoria_atual": get_ticket_category_name(ticket_detail),
                    "categoria_atual_id": get_ticket_category_id(ticket_detail),
                    "mensagem": f"Chamado #{ticket_detail.get('code')} foi transferido de '{old_attendant_name}' para '{new_attendant_name}'."
                })
                changes_detected = True
                
            old_answers_count = len(cached_item.get('answers', []))
            new_answers_count = len(ticket_detail.get('answers', []))
            if new_answers_count > old_answers_count:
                newest_ans = ticket_detail['answers'][-1]
                actor = newest_ans.get('username') or 'Suporte'
                ts = newest_ans.get('answeredAt') or datetime.utcnow().isoformat() + 'Z'
                new_notifications.append({
                    "id": f"{oid}_reply_{int(time.time())}",
                    "timestamp": ts,
                    "ticket_id": oid,
                    "code": ticket_detail.get('code'),
                    "tipo": "nova_resposta",
                    "status_anterior": old_status,
                    "status_atual": new_status,
                    "categoria_atual": get_ticket_category_name(ticket_detail),
                    "categoria_atual_id": get_ticket_category_id(ticket_detail),
                    "atendente_atual": get_ticket_attendant_name(ticket_detail),
                    "attendant_id": ticket_detail.get('attendantId'),
                    "mensagem": f"Chamado #{ticket_detail.get('code')} recebeu uma nova resposta de '{actor}'."
                })
                changes_detected = True
        else:
            if not full_import and is_monitorable_ticket(ticket_detail):
                cat_name = ticket_detail.get('category', {}).get('name', 'Sem Categoria')
                req_name = ticket_detail.get('requester', {}).get('name', 'Desconhecido')
                ts = ticket_detail.get('createdAt') or datetime.utcnow().isoformat() + 'Z'
                new_notifications.append({
                    "id": f"{oid}_novo_{int(time.time())}",
                    "timestamp": ts,
                    "ticket_id": oid,
                    "code": ticket_detail.get('code'),
                    "tipo": "novo_chamado",
                    "status_anterior": None,
                    "status_atual": ticket_detail.get('status'),
                    "categoria_atual": get_ticket_category_name(ticket_detail),
                    "categoria_atual_id": get_ticket_category_id(ticket_detail),
                    "atendente_atual": get_ticket_attendant_name(ticket_detail),
                    "attendant_id": ticket_detail.get('attendantId'),
                    "mensagem": f"Novo chamado #{ticket_detail.get('code')} criado por '{req_name}' (Categoria: {cat_name})."
                })
                changes_detected = True
                
        updated_state[oid] = ticket_detail
        
    if changes_detected:
        notifications = new_notifications + notifications
        notifications.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        notifications = notifications[:NOTIFICATION_HISTORY_LIMIT]
        save_json_file(CHAMADOS_NOTIFICATIONS_FILE, notifications)

    data_changed = any(
        public_ticket_data(updated_state[oid]) != public_ticket_data(cached_tickets.get(oid, {}))
        for oid in updated_state
    )
    if updated_state != cached_tickets:
        with chamados_state_lock:
            save_json_file(CHAMADOS_STATE_FILE, updated_state)
    if data_changed:
        chamados_data_revision += 1
    print(f"[CHAMADOS STATE] Cache atualizado. {len(updated_state)} chamados em cache.")
    return True

def get_feedback_stats():
    cached = load_json_file(CHAMADOS_STATE_FILE, {})
    ratings = []
    attendants = {}
    for ticket in cached.values():
        if not is_finished_or_waiting_feedback(ticket):
            continue
        feedback = ticket.get('feedback')
        if not isinstance(feedback, dict):
            continue
        rating = feedback.get('rating')
        try:
            rating_num = float(rating)
        except (TypeError, ValueError):
            continue
        if rating_num > 0:
            ratings.append(rating_num)
            attendant_name = get_ticket_attendant_name(ticket)
            bucket = attendants.setdefault(attendant_name, [])
            bucket.append(rating_num)

    average = round(sum(ratings) / len(ratings), 2) if ratings else None
    by_attendant = []
    for attendant_name, values in attendants.items():
        by_attendant.append({
            "attendant": attendant_name,
            "average": round(sum(values) / len(values), 2),
            "count": len(values)
        })
    by_attendant.sort(key=lambda item: (-item["average"], -item["count"], item["attendant"]))
    return {
        "average": average,
        "count": len(ratings),
        "lookbackDays": TICKETS_LOOKBACK_DAYS,
        "byAttendant": by_attendant
    }

def chamados_poll_loop():
    print("[CHAMADOS THREAD] Thread de sincronização em segundo plano iniciada.")
    cached = load_json_file(CHAMADOS_STATE_FILE, {})
    is_empty = len(cached) == 0
    last_full_sync = 0
    is_startup_sync = True
    
    while True:
        try:
            should_full_sync = is_empty or (time.time() - last_full_sync >= FULL_SYNC_INTERVAL_SECONDS)
            if should_full_sync:
                with chamados_sync_lock:
                    set_chamados_sync_status(True, "sincronizando dados")
                    try:
                        sync_tickets_data(
                            full_import=is_empty,
                            lookback_days=TICKETS_LOOKBACK_DAYS,
                            detail_refresh_seconds=DETAIL_REFRESH_SECONDS,
                            collect_feedback=is_startup_sync
                        )
                    finally:
                        set_chamados_sync_status(False)
                last_full_sync = time.time()
            else:
                with chamados_sync_lock:
                    set_chamados_sync_status(True, "sincronizando dados")
                    try:
                        sync_tickets_data(
                            full_import=False,
                            lookback_days=TICKETS_RECENT_LOOKBACK_DAYS,
                            detail_refresh_seconds=DETAIL_REFRESH_SECONDS
                        )
                    finally:
                        set_chamados_sync_status(False)
            is_empty = False
            is_startup_sync = False
        except Exception as e:
            print(f"[CHAMADOS POLLING ERROR] Falha no loop de sincronização: {e}")
        time.sleep(POLL_INTERVAL_SECONDS)


# ==============================================================================
# DASHBOARD BI & GLOBAL AI CHAT ASSISTANT ENGINE
# ==============================================================================

DASHBOARD_DIR = os.path.join(MONITOR_APP_DIR, "app_dashboard")
DASHBOARD_DATA_DIR = os.path.join(MONITOR_DATA_DIR, "app_dashboard")
os.makedirs(DASHBOARD_DIR, exist_ok=True)
os.makedirs(DASHBOARD_DATA_DIR, exist_ok=True)

SALES_CACHE_FILE = os.path.join(MONITOR_DATA_DIR, "sales_cache.json")
SALES_HISTORY_META_FILE = os.path.join(DASHBOARD_DATA_DIR, "sales_history_meta.json")
PRODUCTS_CACHE_FILE = os.path.join(MONITOR_DATA_DIR, "products_cache.json")
BI_INVENTORY_CACHE_FILE = os.path.join(DASHBOARD_DATA_DIR, "inventory_cache.json")
BI_SYNC_INTERVAL_SECONDS = 30 * 60
BI_INVENTORY_INTERVAL_SECONDS = 6 * 60 * 60
BI_SALES_LOOKBACK_DAYS = 14
BI_HISTORY_CHUNK_DAYS = 120
BI_HISTORY_MAX_EMPTY_CHUNK_DAYS = 3650
BI_HISTORY_EARLIEST_DATE = datetime(2019, 1, 1)
BI_CATALOG_BATCH_PAGES = 4
BI_CATALOG_PAGE_SIZE = 300

def find_env_file():
    candidates = [
        os.path.join(MONITOR_APP_DIR, ".env"),
        os.path.join(MONITOR_DATA_DIR, ".env"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
        os.path.join(os.getcwd(), ".env")
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

def load_env_vars():
    env_file = find_env_file()
    env_vars = {}
    if os.path.exists(env_file):
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    if "=" in line and not line.strip().startswith("#"):
                        k, v = line.strip().split("=", 1)
                        env_vars[k.strip()] = v.strip().strip('"').strip("'")
        except Exception as e:
            print(f"[ENV] Erro ao ler env: {e}")
    return env_vars

def get_gemini_token():
    token = os.environ.get("GEMINI_TOKEN")
    if not token:
        token = load_env_vars().get("GEMINI_TOKEN")
    return token

sales_cache = []
sales_index = []
sales_index_dates = []
sales_daily_map = {}
sales_daily_index = []
sales_daily_dates = []
sales_daily_ready = False
sales_cache_generation = 0
products_cache = {}
inventory_cache = {
    "products": {}, "stock": {}, "names": {}, "syncedAt": None,
    "productCursor": 0, "catalogComplete": False,
}
cnpj_names = {}
sales_lock = threading.Lock()
bi_data_lock = threading.RLock()
bi_sync_lock = threading.Lock()
bi_dashboard_cache = {}
bi_dashboard_cache_lock = threading.Lock()
bi_slow_cache = {}
bi_slow_cache_lock = threading.Lock()
bi_data_revision = 0
sales_history_meta = {"version": 2, "cursor": None, "complete": False, "windowDays": BI_HISTORY_CHUNK_DAYS}
bi_sync_status = {
    "is_syncing": False,
    "phase": "",
    "startedAt": None,
    "finishedAt": None,
    "error": None,
}

def safe_float(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        if isinstance(value, str):
            value = value.strip().replace("R$", "").replace(" ", "")
            if "," in value and "." in value:
                value = value.replace(".", "").replace(",", ".")
            elif "," in value:
                value = value.replace(",", ".")
        number = float(value)
        return number if number == number and abs(number) != float("inf") else default
    except (TypeError, ValueError, OverflowError):
        return default

def normalize_document(value):
    return "".join(ch for ch in str(value or "") if ch.isdigit())

def get_item_identity(item):
    product = item.get("produto") if isinstance(item.get("produto"), dict) else {}
    product_id = item.get("idProduto") or product.get("id")
    ref = (
        item.get("referencia") or item.get("codigoInterno") or
        product.get("codigoInterno") or product.get("codigoSistema") or
        product.get("codigoBarras") or (f"ID {product_id}" if product_id else "S/R")
    )
    desc = item.get("descricao") or product.get("descricao") or "Sem descricao"
    return str(product_id or ""), str(ref).strip(), str(desc).strip()

def is_cancelled_sale(order):
    status = str(order.get("statusVenda") or "").upper()
    return bool(order.get("cancelado")) or status in {"CANCELADO", "CANCELADA"}

def find_data_file(filename):
    candidates = [
        os.path.join(MONITOR_DATA_DIR, filename),
        os.path.join(MONITOR_APP_DIR, filename),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), filename),
        os.path.join(os.getcwd(), filename),
        os.path.join(r"C:\Users\Home\Desktop\monitores_central", filename)
    ]
    for c in candidates:
        if os.path.exists(c) and os.path.getsize(c) > 0:
            return c
    return None

def load_sales_from_json_file():
    global sales_cache, cnpj_names, sales_history_meta
    sales_file = find_data_file("sales_cache.json")
    if sales_file:
        try:
            with open(sales_file, "r", encoding="utf-8") as f:
                raw_sales = json.load(f)
            
            slim_sales = []
            for s in raw_sales:
                cnpj = s.get("franchiseCnpj") or s.get("entidade", {}).get("documento")
                name = s.get("franchiseName") or s.get("entidade", {}).get("nome")
                if cnpj and name:
                    cnpj_names[cnpj] = name
                
                slim_items = []
                for i in s.get("itens", []):
                    ref = i.get("referencia") or (i.get("produto") if isinstance(i.get("produto"), dict) else {}).get("codigoSistema", "S/R")
                    desc = i.get("descricao") or (i.get("produto") if isinstance(i.get("produto"), dict) else {}).get("descricao", "Sem descrição")
                    qty = safe_float(i.get("quantidade"), 1.0)
                    val = safe_float(i.get("valorTotal"), 0.0)
                    cost = safe_float(i.get("valorCusto"), 0.0)
                    slim_items.append({
                        "referencia": ref,
                        "descricao": desc,
                        "quantidade": qty,
                        "valorTotal": val,
                        "valorCusto": cost
                    })

                slim_sales.append({
                    "id": s.get("id"),
                    "data": s.get("data"),
                    "hora": s.get("horario") or s.get("hora", "00:00"),
                    "franchiseCnpj": cnpj,
                    "franchiseName": name,
                    "cancelado": bool(s.get("cancelado")),
                    "statusVenda": s.get("statusVenda"),
                    "valorTotal": safe_float(s.get("valorTotal"), 0.0),
                    "itens": slim_items
                })

            sales_cache = slim_sales
            print(f"[BI SERVER] Carregadas {len(sales_cache)} vendas otimizadas de {sales_file}.")
            print(f"[BI SERVER] Mapeados {len(cnpj_names)} nomes de franquias a partir do cache de vendas.")
        except Exception as e:
            print(f"[BI SERVER] Erro ao ler cache de vendas ({sales_file}): {e}")
            sales_cache = []
    else:
        print("[BI SERVER] Arquivo sales_cache.json nao foi encontrado!")
        sales_cache = []
    persisted_meta = load_json_file(SALES_HISTORY_META_FILE, {})
    if isinstance(persisted_meta, dict):
        is_current_strategy = int(persisted_meta.get("version") or 0) == 2
        sales_history_meta.update({
            "version": 2,
            "cursor": persisted_meta.get("cursor"),
            "complete": bool(persisted_meta.get("complete")) if is_current_strategy else False,
            "windowDays": max(
                BI_HISTORY_CHUNK_DAYS,
                int(persisted_meta.get("windowDays") or BI_HISTORY_CHUNK_DAYS),
            ),
        })
    rebuild_sales_index()

def load_products_from_json_file():
    global products_cache, inventory_cache, cnpj_names
    products = []
    prod_file = find_data_file("products_cache.json")
    if prod_file:
        try:
            with open(prod_file, "r", encoding="utf-8") as f:
                products = json.load(f)
            print(f"[BI SERVER] Carregados {len(products)} produtos de {prod_file}.")
            for franchise in get_franchise_mapping():
                products_cache[franchise["cnpj"]] = products
        except Exception as error:
            print(f"[BI SERVER] Erro ao ler cache JSON de produtos ({prod_file}): {error}")

    persisted = load_json_file(BI_INVENTORY_CACHE_FILE, {})
    if isinstance(persisted, dict) and persisted.get("products"):
        inventory_cache = {
            "products": persisted.get("products", {}),
            "stock": persisted.get("stock", {}),
            "names": persisted.get("names", {}),
            "syncedAt": persisted.get("syncedAt"),
            "productCursor": max(0, int(persisted.get("productCursor") or 0)),
            "catalogComplete": bool(persisted.get("catalogComplete")),
        }
        cnpj_names.update(inventory_cache["names"])
        print(
            f"[BI SERVER] Inventario real carregado: {len(inventory_cache['products'])} produtos, "
            f"{len(inventory_cache['stock'])} posicoes."
        )
    elif products:
        inventory_cache["products"] = {
            str(product.get("id")): product for product in products if product.get("id") is not None
        }
    return products

def api_get_page(endpoint, token, offset=0, page_size=500, filters=None):
    params = {"token": token, "inicio": offset, "quantidade": page_size}
    params.update(filters or {})
    last_error = None
    for attempt in range(3):
        try:
            response = requests.get(
                f"https://integrador.varejonline.com.br/apps/api/{endpoint}",
                params=params,
                timeout=(10, 60),
                verify=False,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError(f"API {endpoint} retornou formato inesperado")
            return payload
        except (requests.RequestException, ValueError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise last_error

def api_get_all(endpoint, token, filters=None):
    requested_page_size = 500
    first = api_get_page(endpoint, token, 0, requested_page_size, filters)
    if not first:
        return first
    effective_page_size = len(first)
    result = list(first)
    seen_signatures = {
        json.dumps([len(first), first[0], first[-1]], ensure_ascii=False, sort_keys=True, default=str)
    }
    offset = effective_page_size
    for _batch in range(2500):
        offsets = [offset + index * effective_page_size for index in range(3)]
        with ThreadPoolExecutor(max_workers=3) as executor:
            pages = list(executor.map(
                lambda current: api_get_page(endpoint, token, current, requested_page_size, filters),
                offsets,
            ))
        reached_end = False
        for page in pages:
            if not page:
                reached_end = True
                break
            signature = json.dumps(
                [len(page), page[0], page[-1]], ensure_ascii=False, sort_keys=True, default=str
            )
            if signature in seen_signatures:
                reached_end = True
                break
            seen_signatures.add(signature)
            result.extend(page)
            if len(page) < effective_page_size:
                reached_end = True
                break
        if reached_end:
            break
        offset += effective_page_size * len(offsets)
    return result

def build_entity_map(companies):
    entity_map = {}
    names = {}
    for company in companies:
        cnpj = company.get("documento") or ""
        if len(normalize_document(cnpj)) != 14:
            continue
        company_name = str(company.get("grupoEmpresarial") or "").strip()
        for entity in company.get("entidades") or []:
            entity_id = str(entity.get("id") or "")
            entity_name = str(entity.get("nome") or "").strip()
            if entity_id:
                entity_map[entity_id] = cnpj
            names[cnpj] = entity_name or company_name or names.get(cnpj) or "Franquia"
    return entity_map, names

def normalize_product(product):
    product_id = str(product.get("id") or "")
    costs = {}
    for cost in product.get("listCustoReferencial") or []:
        entity_id = str(cost.get("entidade") or "")
        if entity_id:
            costs[entity_id] = safe_float(cost.get("precoCusto"))
    return product_id, {
        "id": product.get("id"),
        "ref": str(product.get("codigoInterno") or product.get("codigoSistema") or product_id or "S/R"),
        "desc": str(product.get("descricao") or "Sem descricao"),
        "preco": safe_float(product.get("preco")),
        "custo": safe_float(product.get("custoReferencial")),
        "custos": costs,
        "ativo": bool(product.get("ativo", True)) and not bool(product.get("deletado")),
    }

def fetch_product_catalog_batch(token, cursor=0):
    offsets = [
        cursor + index * BI_CATALOG_PAGE_SIZE
        for index in range(BI_CATALOG_BATCH_PAGES)
    ]
    with ThreadPoolExecutor(max_workers=BI_CATALOG_BATCH_PAGES) as executor:
        pages = list(executor.map(
            lambda offset: api_get_page(
                "produtos", token, offset, BI_CATALOG_PAGE_SIZE,
                {"somenteAtivos": "false"},
            ),
            offsets,
        ))

    products = {}
    reached_end = False
    next_cursor = cursor
    for page in pages:
        if not page:
            reached_end = True
            break
        for raw_product in page:
            product_id, normalized = normalize_product(raw_product)
            if product_id:
                products[product_id] = normalized
        next_cursor += len(page)
        if len(page) < BI_CATALOG_PAGE_SIZE:
            reached_end = True
            break
    return products, next_cursor, reached_end

def fetch_inventory_for_token(token):
    companies = api_get_all("empresas", token)
    entity_map, names = build_entity_map(companies)
    balances = api_get_all("saldos-mercadorias", token)
    stock = {}
    for balance in balances:
        entity = balance.get("entidade") if isinstance(balance.get("entidade"), dict) else {}
        entity_id = str(balance.get("idEntidade") or entity.get("id") or "")
        cnpj = entity.get("documento") or entity_map.get(entity_id) or ""
        product = balance.get("produto") if isinstance(balance.get("produto"), dict) else {}
        product_id = str(balance.get("idProduto") or product.get("id") or "")
        if not cnpj or not product_id:
            continue
        names.setdefault(cnpj, str(entity.get("nome") or "").strip())
        stock[f"{cnpj}|{product_id}"] = {
            "cnpj": cnpj, "productId": product_id, "entityId": entity_id,
            "qty": safe_float(balance.get("quantidade")),
        }
    return names, stock

def fetch_sales_for_token(token, start_date, end_date):
    orders = api_get_all("pedidos", token, {
        "desde": start_date.strftime("%d/%m/%Y"),
        "ate": end_date.strftime("%d/%m/%Y"),
        "carregarPagamentos": "false",
    })
    normalized = []
    names = {}
    for order in orders:
        entity = order.get("entidade") if isinstance(order.get("entidade"), dict) else {}
        cnpj = entity.get("documento") or order.get("franchiseCnpj")
        name = entity.get("nome") or order.get("franchiseName")
        if not cnpj:
            continue
        order["franchiseCnpj"] = cnpj
        if name:
            order["franchiseName"] = name
            names[cnpj] = str(name).strip()
        normalized.append(order)
    return normalized, names

def sale_cache_key(order):
    cnpj = order.get("franchiseCnpj") or ""
    external_id = order.get("idSaida") or order.get("id") or order.get("numero") or ""
    return f"{cnpj}|{external_id}|{order.get('data', '')}|{order.get('horario', '')}"

def fetch_sales_window(unique_tokens, start_date, end_date):
    fresh_sales = []
    fresh_names = {}
    errors = []
    with ThreadPoolExecutor(max_workers=min(API_WORKERS, len(unique_tokens))) as executor:
        futures = [
            executor.submit(fetch_sales_for_token, token, start_date, end_date)
            for token in unique_tokens
        ]
        for future in as_completed(futures):
            try:
                orders, names = future.result()
                fresh_sales.extend(orders)
                fresh_names.update(names)
            except Exception as error:
                errors.append(str(error))
    return fresh_sales, fresh_names, errors

def merge_sales_cache(fresh_sales, fresh_names):
    global sales_cache, cnpj_names, bi_data_revision, sales_cache_generation
    if not fresh_sales:
        return 0
    with sales_lock:
        affected_dates = {
            sale_date.strftime("%Y-%m-%d")
            for sale_date in (parse_sale_date(order) for order in fresh_sales)
            if sale_date
        }
        merged = {sale_cache_key(order): order for order in sales_cache}
        previous_count = len(merged)
        for order in fresh_sales:
            merged[sale_cache_key(order)] = order
        sales_cache = list(merged.values())
        sales_cache_generation += 1
        rebuild_sales_index_locked(build_daily=False)
        if sales_daily_ready and affected_dates:
            for day_key in affected_dates:
                sales_daily_map.pop(day_key, None)
            for order in sales_cache:
                sale_date = parse_sale_date(order)
                if sale_date and sale_date.strftime("%Y-%m-%d") in affected_dates:
                    add_order_to_daily_summary(sales_daily_map, order, sale_date)
            refresh_sales_daily_index_locked()
        save_compact_json_file(SALES_CACHE_FILE, sales_cache)
        bi_data_revision += 1
    with bi_dashboard_cache_lock:
        bi_dashboard_cache.clear()
    with bi_slow_cache_lock:
        bi_slow_cache.clear()
    with bi_data_lock:
        cnpj_names.update(fresh_names)
    return max(0, len(merged) - previous_count)

def update_sales_cache_from_api(unique_tokens, start_date=None, end_date=None):
    end_date = end_date or datetime.now()
    start_date = start_date or (end_date - timedelta(days=BI_SALES_LOOKBACK_DAYS))
    window_days = max(1, (end_date - start_date).days)
    fresh_sales, fresh_names, errors = fetch_sales_window(unique_tokens, start_date, end_date)

    if not fresh_sales:
        raise RuntimeError("A API nao retornou vendas recentes; o cache anterior foi preservado")
    merge_sales_cache(fresh_sales, fresh_names)
    print(
        f"[BI SALES] {len(fresh_sales)} vendas de {window_days} dias recebidas; "
        f"cache total {len(sales_cache)}."
    )
    return errors

def backfill_sales_history():
    global sales_history_meta
    if sales_history_meta.get("complete"):
        return True
    if not bi_sync_lock.acquire(blocking=False):
        return False
    bi_sync_status.update({
        "is_syncing": True,
        "phase": "Ampliando historico de vendas",
        "startedAt": now_iso(),
        "finishedAt": None,
        "error": None,
    })
    try:
        unique_tokens = list(dict.fromkeys(
            franchise["token"] for franchise in get_franchise_mapping() if franchise.get("token")
        ))
        if not unique_tokens:
            raise RuntimeError("Nenhum token do Varejo Online foi configurado")

        oldest, _newest = sales_cache_coverage()
        cursor_value = sales_history_meta.get("cursor")
        try:
            window_end = datetime.strptime(cursor_value, "%Y-%m-%d") if cursor_value else None
        except (TypeError, ValueError):
            window_end = None
        if window_end is None or (oldest and window_end >= oldest):
            window_end = (oldest or datetime.now()) - timedelta(days=1)
        if window_end < BI_HISTORY_EARLIEST_DATE:
            sales_history_meta.update({"version": 2, "complete": True})
            save_compact_json_file(SALES_HISTORY_META_FILE, sales_history_meta)
            bi_sync_status.update({"finishedAt": now_iso(), "error": None})
            return True
        window_days = max(
            BI_HISTORY_CHUNK_DAYS,
            int(sales_history_meta.get("windowDays") or BI_HISTORY_CHUNK_DAYS),
        )
        window_start = max(
            BI_HISTORY_EARLIEST_DATE,
            window_end - timedelta(days=window_days - 1),
        )

        fresh_sales, fresh_names, errors = fetch_sales_window(
            unique_tokens, window_start, window_end
        )
        added = merge_sales_cache(fresh_sales, fresh_names)
        if errors:
            warning = f"{len(errors)} grupo(s) falharam no historico; o bloco sera repetido"
            bi_sync_status.update({"finishedAt": now_iso(), "error": warning})
            return False

        reached_history_floor = window_start <= BI_HISTORY_EARLIEST_DATE
        next_window_days = BI_HISTORY_CHUNK_DAYS if fresh_sales else min(
            window_days * 2, BI_HISTORY_MAX_EMPTY_CHUNK_DAYS
        )
        sales_history_meta = {
            "version": 2,
            "cursor": (window_start - timedelta(days=1)).strftime("%Y-%m-%d"),
            "complete": reached_history_floor,
            "windowDays": next_window_days,
        }
        save_compact_json_file(SALES_HISTORY_META_FILE, sales_history_meta)
        oldest_after, _ = sales_cache_coverage()
        print(
            f"[BI HISTORY] {window_start:%d/%m/%Y} a {window_end:%d/%m/%Y}: "
            f"{len(fresh_sales)} recebidas, {added} novas; cobertura desde "
            f"{oldest_after:%d/%m/%Y}." if oldest_after else "[BI HISTORY] Cache ainda vazio."
        )
        bi_sync_status.update({"finishedAt": now_iso(), "error": None})
        return True
    except Exception as error:
        bi_sync_status.update({"finishedAt": now_iso(), "error": str(error)})
        print(f"[BI HISTORY ERROR] {error}")
        return False
    finally:
        bi_sync_status.update({"is_syncing": False, "phase": ""})
        bi_sync_lock.release()

def sync_bi_inventory(full_inventory=True):
    global inventory_cache, cnpj_names, bi_data_revision
    if not bi_sync_lock.acquire(blocking=False):
        return False
    bi_sync_status.update({
        "is_syncing": True, "phase": "Atualizando catalogo e estoque",
        "startedAt": now_iso(), "finishedAt": None, "error": None,
    })
    try:
        mappings = get_franchise_mapping()
        unique_tokens = list(dict.fromkeys(f["token"] for f in mappings if f.get("token")))
        if not unique_tokens:
            raise RuntimeError("Nenhum token do Varejo Online foi configurado")

        with sales_lock:
            latest_sale = max(
                (parse_sale_date(order) for order in sales_cache),
                default=None,
                key=lambda value: value or datetime.min,
            )
        now = datetime.now()
        recent_days = 3 if latest_sale and latest_sale >= now - timedelta(days=2) else 14
        bi_sync_status["phase"] = "Atualizando vendas recentes"
        sales_errors = update_sales_cache_from_api(
            unique_tokens, now - timedelta(days=recent_days), now
        )
        if not latest_sale or latest_sale < now - timedelta(days=14):
            bi_sync_status["phase"] = "Completando vendas dos ultimos 30 dias"
            sales_errors.extend(update_sales_cache_from_api(
                unique_tokens,
                now - timedelta(days=30),
                now - timedelta(days=14),
            ))
        with bi_data_lock:
            products = dict(inventory_cache.get("products", {}))
            product_cursor = max(0, int(inventory_cache.get("productCursor") or 0))
            catalog_complete = bool(inventory_cache.get("catalogComplete"))
        if catalog_complete and full_inventory:
            product_cursor = 0
            catalog_complete = False
        if not catalog_complete:
            bi_sync_status["phase"] = "Atualizando catalogo de produtos"
            catalog_batch, next_cursor, reached_end = fetch_product_catalog_batch(
                unique_tokens[0], product_cursor
            )
            products.update(catalog_batch)
            product_cursor = 0 if reached_end else next_cursor
            catalog_complete = reached_end
            with bi_data_lock:
                inventory_cache["products"] = products
                inventory_cache["productCursor"] = product_cursor
                inventory_cache["catalogComplete"] = catalog_complete
                catalog_snapshot = dict(inventory_cache)
                bi_data_revision += 1
            save_compact_json_file(BI_INVENTORY_CACHE_FILE, catalog_snapshot)
            with bi_dashboard_cache_lock:
                bi_dashboard_cache.clear()

        if not full_inventory:
            warning = f"{len(sales_errors)} grupo(s) falharam; sera tentado novamente" if sales_errors else None
            bi_sync_status.update({"finishedAt": now_iso(), "error": warning})
            return True

        all_names = {}
        all_stock = {}
        bi_sync_status["phase"] = "Atualizando saldos de estoque"
        token_errors = []
        with ThreadPoolExecutor(max_workers=min(API_WORKERS, len(unique_tokens))) as executor:
            futures = [executor.submit(fetch_inventory_for_token, token) for token in unique_tokens]
            for future in as_completed(futures):
                try:
                    names, stock = future.result()
                    all_names.update({key: value for key, value in names.items() if value})
                    all_stock.update(stock)
                except Exception as error:
                    token_errors.append(str(error))
        synced_at = now_iso()
        if token_errors:
            with bi_data_lock:
                merged_stock = dict(inventory_cache.get("stock", {}))
                merged_names = dict(inventory_cache.get("names", {}))
            merged_stock.update(all_stock)
            merged_names.update(all_names)
            all_stock = merged_stock
            all_names = merged_names
        updated = {
            "products": products,
            "stock": all_stock,
            "names": all_names,
            "syncedAt": synced_at,
            "productCursor": product_cursor,
            "catalogComplete": catalog_complete,
        }
        with bi_data_lock:
            inventory_cache = updated
            cnpj_names.update(all_names)
            save_compact_json_file(BI_INVENTORY_CACHE_FILE, updated)
            bi_data_revision += 1
        with bi_dashboard_cache_lock:
            bi_dashboard_cache.clear()
        total_errors = len(token_errors) + len(sales_errors)
        sync_warning = f"{total_errors} grupo(s) falharam; sera tentado novamente" if total_errors else None
        bi_sync_status.update({"finishedAt": synced_at, "error": sync_warning})
        catalog_state = "completo" if catalog_complete else f"cursor {product_cursor}"
        print(
            f"[BI SYNC] {len(products)} produtos ({catalog_state}) e "
            f"{len(all_stock)} posicoes de estoque atualizados."
        )
        return True
    except Exception as error:
        bi_sync_status.update({"finishedAt": now_iso(), "error": str(error)})
        print(f"[BI SYNC ERROR] {error}")
        return False
    finally:
        bi_sync_status.update({"is_syncing": False, "phase": ""})
        bi_sync_lock.release()

def bi_poll_loop():
    last_inventory_sync = 0
    synced_at = inventory_cache.get("syncedAt")
    if synced_at:
        try:
            last_inventory_sync = datetime.fromisoformat(synced_at).timestamp()
        except (TypeError, ValueError):
            pass
    while True:
        should_refresh_inventory = (
            not inventory_cache.get("stock") or
            time.time() - last_inventory_sync >= BI_INVENTORY_INTERVAL_SECONDS
        )
        synced = sync_bi_inventory(full_inventory=should_refresh_inventory)
        if not synced:
            time.sleep(30)
            continue
        if should_refresh_inventory and inventory_cache.get("syncedAt"):
            last_inventory_sync = time.time()
        try:
            today = datetime.now().strftime("%Y-%m-%d")
            start = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
            calculate_dashboard_data(start, today, [f["cnpj"] for f in get_franchise_mapping()])
        except Exception as error:
            print(f"[BI WARMUP] Falha ao aquecer dashboard: {error}")
        time.sleep(BI_SYNC_INTERVAL_SECONDS)

def bi_history_backfill_loop():
    time.sleep(10)
    while True:
        if sales_history_meta.get("complete"):
            time.sleep(6 * 60 * 60)
            continue
        progressed = backfill_sales_history()
        time.sleep(10 if progressed else 45)

def get_franchise_mapping():
    mapping = []
    env_vars = load_env_vars()
    idx = 1
    while True:
        cnpj = env_vars.get(f"CNPJ_{idx}")
        token = env_vars.get(f"TOKEN_{idx}")
        if not cnpj or not token:
            break
        name = cnpj_names.get(cnpj)
        if not name and cnpj == "62.672.930/0001-49":
            name = "SANTO SANTO SANTO MARILIA"
        if not name:
            if cnpj == "06.128.236/0001-94": name = "SANTO SANTO SANTO - BRASÍLIA ASA SUL"
            elif cnpj == "06.128.236/0002-75": name = "SANTO SANTO SANTO BRASILIA NORTE"
            elif cnpj == "29.372.123/0001-35": name = "SANTO SANTO SANTO PRESENTES EIRELI"
            elif cnpj == "39.378.362/0001-56": name = "SANTO SANTO SANTO - SALVADOR"
            elif cnpj == "44.151.732/0001-58": name = "JULIANA PATRICIA VENANCIO - SANTO SANTO SANTO"
            elif cnpj == "48.790.054/0001-24": name = "SANTO SANTO SANTO - APARECIDA GOIANIA"
            elif cnpj == "44.479.734/0001-70": name = "SANTO SANTO SANTO FRANCHISING LTDA"
            else: name = f"Franquia {idx} - {cnpj}"
        mapping.append({"id": idx, "name": name, "cnpj": cnpj, "token": token})
        idx += 1
    return mapping

def parse_sale_date(order):
    value = str(order.get("data") or "").strip()
    for pattern in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value[:10], pattern)
        except ValueError:
            continue
    return None

def add_order_to_daily_summary(daily, order, sale_date=None):
    sale_date = sale_date or parse_sale_date(order)
    if not sale_date or is_cancelled_sale(order):
        return
    cnpj = order.get("franchiseCnpj")
    if not cnpj:
        return
    day_key = sale_date.strftime("%Y-%m-%d")
    day = daily.setdefault(day_key, {"stores": {}})
    store = day["stores"].setdefault(cnpj, {
        "revenue": 0.0, "count": 0, "hours": {}, "products": {}
    })
    revenue = safe_float(order.get("valorTotal"))
    store["revenue"] += revenue
    store["count"] += 1
    hour = str(order.get("horario") or order.get("hora") or "00:00").split(":")[0]
    if hour.isdigit():
        store["hours"][hour] = store["hours"].get(hour, 0.0) + revenue
    for item in order.get("itens") or []:
        _product_id, ref, desc = get_item_identity(item)
        key = (ref, desc)
        product = store["products"].setdefault(key, [0.0, 0.0])
        product[0] += safe_float(item.get("quantidade"), 1.0)
        product[1] += safe_float(item.get("valorTotal"))

def refresh_sales_daily_index_locked():
    global sales_daily_index, sales_daily_dates
    sales_daily_index = [
        (datetime.strptime(key, "%Y-%m-%d"), value)
        for key, value in sorted(sales_daily_map.items())
    ]
    sales_daily_dates = [entry[0] for entry in sales_daily_index]

def rebuild_sales_index_locked(build_daily=False):
    global sales_index, sales_index_dates, sales_daily_map, sales_daily_ready
    entries = []
    daily = {} if build_daily else None
    for order in sales_cache:
        sale_date = parse_sale_date(order)
        if sale_date:
            entries.append((sale_date, order))
        if build_daily:
            add_order_to_daily_summary(daily, order, sale_date)
    entries.sort(key=lambda entry: entry[0])
    sales_index = entries
    sales_index_dates = [entry[0] for entry in entries]
    if build_daily:
        sales_daily_map = daily
        refresh_sales_daily_index_locked()
        sales_daily_ready = True

def rebuild_sales_index(build_daily=False):
    with sales_lock:
        rebuild_sales_index_locked(build_daily=build_daily)

def build_sales_daily_index_background():
    global sales_daily_map, sales_daily_ready
    while True:
        with sales_lock:
            snapshot = list(sales_cache)
            generation = sales_cache_generation
        daily = {}
        for order in snapshot:
            add_order_to_daily_summary(daily, order)
        with sales_lock:
            if generation != sales_cache_generation:
                continue
            sales_daily_map = daily
            refresh_sales_daily_index_locked()
            sales_daily_ready = True
            print(f"[BI INDEX] Resumo diario pronto: {len(sales_daily_map)} dias consolidados.")
            return

def sales_cache_coverage():
    with sales_lock:
        if not sales_index_dates:
            return None, None
        return sales_index_dates[0], sales_index_dates[-1]

def filter_sales(data_inicio, data_fim, selected_cnpjs=None):
    start = datetime.strptime(data_inicio, "%Y-%m-%d")
    end = datetime.strptime(data_fim, "%Y-%m-%d")
    if start > end:
        return []
    selected = set(selected_cnpjs or [])
    with sales_lock:
        first = bisect_left(sales_index_dates, start)
        last = bisect_right(sales_index_dates, end.replace(hour=23, minute=59, second=59))
        candidates = [entry[1] for entry in sales_index[first:last]]
    return [
        order for order in candidates
        if not is_cancelled_sale(order)
        and (not selected or order.get("franchiseCnpj") in selected)
    ]

def tool_get_general_stats(data_inicio=None, data_fim=None, cnpjs=None):
    if not data_inicio:
        data_inicio = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
    if not data_fim:
        data_fim = datetime.now().strftime("%Y-%m-%d")
    selected_cnpjs = []
    if cnpjs:
        selected_cnpjs = cnpjs if isinstance(cnpjs, list) else [c.strip() for c in cnpjs.split(",") if c.strip()]
    combined = filter_sales(data_inicio, data_fim, selected_cnpjs)
    faturamento = sum(safe_float(o.get("valorTotal")) for o in combined)
    sales_count = len(combined)
    ticket_medio = (faturamento / sales_count) if sales_count > 0 else 0.0
    daily = {}
    for order in combined:
        sale_date = parse_sale_date(order)
        if not sale_date:
            continue
        key = sale_date.strftime("%Y-%m-%d")
        current = daily.setdefault(key, {"faturamento": 0.0, "vendas": 0})
        current["faturamento"] += safe_float(order.get("valorTotal"))
        current["vendas"] += 1
    timeline = [
        {"data": key, "faturamento": round(value["faturamento"], 2), "vendas": value["vendas"]}
        for key, value in sorted(daily.items())
    ]
    best_day = max(timeline, key=lambda item: item["faturamento"], default=None)
    worst_day = min(timeline, key=lambda item: item["faturamento"], default=None)
    monthly = {}
    for item in timeline:
        month = item["data"][:7]
        current = monthly.setdefault(month, {"faturamento": 0.0, "vendas": 0})
        current["faturamento"] += item["faturamento"]
        current["vendas"] += item["vendas"]
    compact_timeline = timeline if len(timeline) <= 370 else [
        {"mes": key, "faturamento": round(value["faturamento"], 2), "vendas": value["vendas"]}
        for key, value in sorted(monthly.items())
    ]
    coverage_start, coverage_end = sales_cache_coverage()
    return {
        "faturamento_total": round(faturamento, 2),
        "quantidade_vendas": sales_count,
        "ticket_medio": round(ticket_medio, 2),
        "periodo": f"{data_inicio} ate {data_fim}",
        "melhor_dia": best_day,
        "menor_dia_com_vendas": worst_day,
        "serie_temporal": compact_timeline,
        "granularidade_serie": "dia" if len(timeline) <= 370 else "mes",
        "cobertura_cache": {
            "inicio": coverage_start.strftime("%Y-%m-%d") if coverage_start else None,
            "fim": coverage_end.strftime("%Y-%m-%d") if coverage_end else None,
            "historico_completo": bool(sales_history_meta.get("complete")),
        },
    }

def tool_get_top_products(data_inicio=None, data_fim=None, cnpjs=None, limit=10):
    if not data_inicio:
        data_inicio = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
    if not data_fim:
        data_fim = datetime.now().strftime("%Y-%m-%d")
    selected_cnpjs = []
    if cnpjs:
        selected_cnpjs = cnpjs if isinstance(cnpjs, list) else [c.strip() for c in cnpjs.split(",") if c.strip()]
    combined = []
    selected_cnpjs_set = set(selected_cnpjs) if selected_cnpjs else None
    with sales_lock:
        for o in sales_cache:
            f_cnpj = o.get("franchiseCnpj")
            if selected_cnpjs_set and (not f_cnpj or f_cnpj not in selected_cnpjs_set):
                continue
            data_str = o.get("data")
            if not data_str: continue
            try:
                parts = data_str.split('-')
                d_obj = datetime(int(parts[2]), int(parts[1]), int(parts[0]))
                if datetime.strptime(data_inicio, "%Y-%m-%d") <= d_obj <= datetime.strptime(data_fim, "%Y-%m-%d"):
                    combined.append(o)
            except Exception: pass

    product_sales = {}
    for o in combined:
        for item in o.get("itens", []):
            ref = item.get("referencia", "S/R")
            desc = item.get("descricao", "Sem descrição")
            qty = float(item.get("quantidade", 1))
            val = float(item.get("valorTotal", 0.0))
            key = (ref, desc)
            if key not in product_sales:
                product_sales[key] = {"qty": 0, "total": 0.0}
            product_sales[key]["qty"] += qty
            product_sales[key]["total"] += val

    sorted_products = [
        {"referencia": k[0], "descricao": k[1], "quantidade": v["qty"], "faturamento": round(v["total"], 2)}
        for k, v in sorted(product_sales.items(), key=lambda x: x[1]["total"], reverse=True)[:int(limit)]
    ]
    return {"top_products": sorted_products, "total_vendas_analisadas": len(combined)}

def tool_get_franchises_list():
    all_franchises = get_franchise_mapping()
    result = []
    for f in all_franchises:
        result.append({"name": f["name"], "cnpj": f["cnpj"]})
    return {"franchises": result}

def tool_get_franchise_performance(data_inicio=None, data_fim=None):
    if not data_inicio:
        data_inicio = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
    if not data_fim:
        data_fim = datetime.now().strftime("%Y-%m-%d")
    all_franchises = get_franchise_mapping()
    franchise_stats = {}
    for f in all_franchises:
        franchise_stats[f["cnpj"]] = {
            "cnpj": f["cnpj"], "name": f["name"],
            "faturamento": 0.0, "sales_count": 0, "ticket_medio": 0.0
        }
    with sales_lock:
        for o in sales_cache:
            f_cnpj = o.get("franchiseCnpj")
            if not f_cnpj or f_cnpj not in franchise_stats: continue
            data_str = o.get("data")
            if not data_str: continue
            try:
                parts = data_str.split('-')
                d_obj = datetime(int(parts[2]), int(parts[1]), int(parts[0]))
                if datetime.strptime(data_inicio, "%Y-%m-%d") <= d_obj <= datetime.strptime(data_fim, "%Y-%m-%d"):
                    val = float(o.get("valorTotal", 0.0))
                    franchise_stats[f_cnpj]["faturamento"] += val
                    franchise_stats[f_cnpj]["sales_count"] += 1
            except Exception: pass

    result = []
    for f_cnpj, stats in franchise_stats.items():
        cnt = stats["sales_count"]
        fat = stats["faturamento"]
        tm = (fat / cnt) if cnt > 0 else 0.0
        result.append({
            "name": stats["name"], "cnpj": f_cnpj,
            "faturamento": round(fat, 2), "sales_count": cnt, "ticket_medio": round(tm, 2)
        })
    result.sort(key=lambda x: x["faturamento"], reverse=True)
    return {"franchise_performance": result}

def tool_get_slow_moving_products(data_fim=None, limit=10, cnpjs=None):
    ref_dt = datetime.strptime(data_fim, "%Y-%m-%d") if data_fim else datetime.now()
    selected = set(cnpjs or [f["cnpj"] for f in get_franchise_mapping()])
    with bi_data_lock:
        products = dict(inventory_cache.get("products", {}))
        stock_positions = list(inventory_cache.get("stock", {}).values())
        names = dict(inventory_cache.get("names", {}))

    stock_by_product = {}
    for position in stock_positions:
        cnpj = position.get("cnpj")
        quantity = safe_float(position.get("qty"))
        if cnpj not in selected or quantity <= 0:
            continue
        product_id = str(position.get("productId") or "")
        current = stock_by_product.setdefault(product_id, {"total": 0.0, "details": [], "entities": []})
        current["total"] += quantity
        current["entities"].append(str(position.get("entityId") or ""))
        current["details"].append({"store": names.get(cnpj) or cnpj_names.get(cnpj) or cnpj, "qty": quantity})

    if not stock_by_product:
        return {"slow_moving": [], "reference_date": ref_dt.strftime("%Y-%m-%d")}

    sales_by_product = {}
    last_sale_dates = {}
    with sales_lock:
        orders = list(sales_cache)
    for order in orders:
        if is_cancelled_sale(order):
            continue
        sale_date = parse_sale_date(order)
        if not sale_date or sale_date > ref_dt:
            continue
        for item in order.get("itens") or []:
            product_id, _ref, _desc = get_item_identity(item)
            if not product_id:
                continue
            sale = sales_by_product.setdefault(product_id, {"qty": 0.0, "total": 0.0})
            sale["qty"] += safe_float(item.get("quantidade"), 1.0)
            sale["total"] += safe_float(item.get("valorTotal"))
            if product_id not in last_sale_dates or sale_date > last_sale_dates[product_id]:
                last_sale_dates[product_id] = sale_date

    slow_moving = []
    for product_id, stock in stock_by_product.items():
        product = products.get(product_id) or {}
        price = safe_float(product.get("preco"))
        entity_costs = product.get("custos") if isinstance(product.get("custos"), dict) else {}
        costs = [safe_float(entity_costs.get(entity_id)) for entity_id in stock["entities"]]
        costs = [cost for cost in costs if cost > 0]
        cost = sum(costs) / len(costs) if costs else safe_float(product.get("custo"))
        if price < 5 or price <= cost:
            continue
        days = max(0, (ref_dt - last_sale_dates[product_id]).days) if product_id in last_sale_dates else 730
        score = (stock["total"] * days) / (price ** 0.5)
        sale = sales_by_product.get(product_id, {"qty": 0.0, "total": 0.0})
        slow_moving.append({
            "ref": product.get("ref") or f"ID {product_id}",
            "desc": product.get("desc") or "Produto sem descricao",
            "qty": round(sale["qty"], 2), "total": round(sale["total"], 2),
            "custo": round(cost, 2), "preco": round(price, 2),
            "estoque": round(stock["total"], 2), "dias_sem_venda": days,
            "score": round(score, 1), "estoque_detalhe": stock["details"],
        })
    slow_moving.sort(key=lambda item: item["score"], reverse=True)
    return {"slow_moving": slow_moving[:int(limit)]}

def tool_get_product_pairs(data_inicio=None, data_fim=None, cnpjs=None, limit=5):
    if not data_inicio:
        data_inicio = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
    if not data_fim:
        data_fim = datetime.now().strftime("%Y-%m-%d")
    selected_cnpjs = []
    if cnpjs:
        selected_cnpjs = cnpjs if isinstance(cnpjs, list) else [c.strip() for c in cnpjs.split(",") if c.strip()]
    combined = []
    selected_cnpjs_set = set(selected_cnpjs) if selected_cnpjs else None
    with sales_lock:
        for o in sales_cache:
            f_cnpj = o.get("franchiseCnpj")
            if selected_cnpjs_set and (not f_cnpj or f_cnpj not in selected_cnpjs_set):
                continue
            data_str = o.get("data")
            if not data_str: continue
            try:
                parts = data_str.split('-')
                d_obj = datetime(int(parts[2]), int(parts[1]), int(parts[0]))
                if datetime.strptime(data_inicio, "%Y-%m-%d") <= d_obj <= datetime.strptime(data_fim, "%Y-%m-%d"):
                    combined.append(o)
            except Exception: pass

    pair_counts = {}
    for order in combined:
        items = order.get("itens", [])
        desc_list = sorted(list(set(i.get("descricao", "").strip() for i in items if i.get("descricao"))))
        for i in range(len(desc_list)):
            for j in range(i + 1, len(desc_list)):
                pair = (desc_list[i], desc_list[j])
                pair_counts[pair] = pair_counts.get(pair, 0) + 1

    sorted_pairs = sorted(pair_counts.items(), key=lambda x: x[1], reverse=True)[:int(limit)]
    results = [{"produto_1": pair[0], "produto_2": pair[1], "frequencia_conjunta": count} for pair, count in sorted_pairs]
    return {"pairs": results, "total_vendas_analisadas": len(combined)}

# --- Pedidos & Chamados & Tools AI Tool Functions ---

def tool_get_pedidos_summary():
    with pedidos_state_lock:
        cached = load_json_file(PEDIDOS_STATE_FILE, {})
    total = len(cached)
    active = [o for o in cached.values() if not is_inactive_order(o)]
    by_status = {}
    providers = set()
    franchisees = set()
    total_val = 0.0

    for o in cached.values():
        st = o.get("situacao", {}).get("descricao", "Outro")
        by_status[st] = by_status.get(st, 0) + 1
        prov = o.get("fornecedor", {}).get("nome")
        if prov: providers.add(prov)
        fran = o.get("franqueado", {}).get("nome")
        if fran: franchisees.add(fran)
        for item in o.get("itensPedido", []):
            qty = float(item.get("quantidadeProdutos") or 0)
            val = float(item.get("valorUnitario") or 0)
            total_val += qty * val

    return {
        "total_pedidos": total,
        "pedidos_ativos": len(active),
        "por_situacao": by_status,
        "total_fornecedores_unicos": len(providers),
        "total_franquias_unicas": len(franchisees),
        "valor_total_estimado": round(total_val, 2)
    }

def tool_search_pedidos(query=None, status=None, limit=10):
    with pedidos_state_lock:
        cached = load_json_file(PEDIDOS_STATE_FILE, {})
    query = (query or "").lower().strip()
    status = (status or "").lower().strip()
    limit = int(limit or 10)
    results = []

    for o in cached.values():
        code = str(o.get("codigo", ""))
        prov = str(o.get("fornecedor", {}).get("nome", "")).lower()
        fran = str(o.get("franqueado", {}).get("nome", "")).lower()
        st_desc = str(o.get("situacao", {}).get("descricao", "")).lower()

        matches_query = not query or (query in code.lower() or query in prov or query in fran or query in st_desc)
        matches_status = not status or status in st_desc
        if not matches_query or not matches_status:
            item_match = False
            if query:
                for item in o.get("itensPedido", []):
                    desc = str(item.get("descricaoProduto", "")).lower()
                    cd = str(item.get("codigo", "")).lower()
                    if query in desc or query in cd:
                        item_match = True
                        break
            if not item_match and query:
                continue

        results.append({
            "codigo": o.get("codigo"),
            "dataCriacao": get_order_creation_date(o),
            "franqueado": o.get("franqueado", {}).get("nome"),
            "fornecedor": o.get("fornecedor", {}).get("nome"),
            "situacao": o.get("situacao", {}).get("descricao"),
            "formaPagamento": o.get("formaPagamento"),
            "qtd_itens": len(o.get("itensPedido", [])),
            "itens_resumo": [f"{item.get('descricaoProduto')} (x{item.get('quantidadeProdutos')})" for item in o.get("itensPedido", [])[:3]]
        })
        if len(results) >= limit: break

    return {"results": results, "total_encontrados": len(results)}

def get_waiting_actor(t):
    if t.get('status') == 'finished':
        return 'none'
    last_actor = t.get('lastInteractionBy')
    if not last_actor and isinstance(t.get('answers'), list) and len(t['answers']) > 0:
        last_answer = t['answers'][-1]
        last_actor = 'franchisee' if last_answer.get('isUserResponse') else 'franchisor'
    if last_actor in ('franchisor', 'attendant'):
        return 'franchisee'
    return 'franchisor'

def tool_get_chamados_summary():
    with chamados_state_lock:
        cached = load_json_file(CHAMADOS_STATE_FILE, {})
    total = len(cached)
    active = [t for t in cached.values() if is_monitorable_ticket(t)]
    waiting_suporte = 0
    waiting_franqueado = 0
    categories = {}
    attendants = {}

    for t in cached.values():
        cat = t.get("category", {}).get("name", "Sem Categoria")
        categories[cat] = categories.get(cat, 0) + 1
        att = t.get("attendantName") or "Não Atribuído"
        attendants[att] = attendants.get(att, 0) + 1
        if is_monitorable_ticket(t):
            waiting = get_waiting_actor(t)
            if waiting == "franchisor": waiting_suporte += 1
            else: waiting_franqueado += 1

    return {
        "total_chamados": total,
        "chamados_ativos": len(active),
        "aguardando_suporte": waiting_suporte,
        "aguardando_franqueado": waiting_franqueado,
        "categorias": categories,
        "atendentes": attendants
    }

def tool_search_chamados(query=None, status=None, category=None, limit=10):
    with chamados_state_lock:
        cached = load_json_file(CHAMADOS_STATE_FILE, {})
    query = (query or "").lower().strip()
    status = (status or "").lower().strip()
    category = (category or "").lower().strip()
    limit = int(limit or 10)
    results = []

    for t in cached.values():
        code = str(t.get("code", ""))
        subj = str(t.get("subject", "")).lower()
        req = str(t.get("requester", {}).get("name", "")).lower()
        fran = str(t.get("franchisee", {}).get("name", "")).lower()
        att = str(t.get("attendantName", "")).lower()
        cat = str(t.get("category", {}).get("name", "")).lower()
        st = str(t.get("status", "")).lower()

        matches_query = not query or (query in code or query in subj or query in req or query in fran or query in att or query in cat)
        matches_status = not status or status in st
        matches_category = not category or category in cat

        if matches_query and matches_status and matches_category:
            results.append({
                "codigo": t.get("code"),
                "assunto": t.get("subject"),
                "solicitante": t.get("requester", {}).get("name"),
                "franquia": t.get("franchisee", {}).get("name"),
                "atendente": t.get("attendantName"),
                "categoria": t.get("category", {}).get("name"),
                "status": t.get("status"),
                "dataCriacao": str(t.get("createdAt", ""))[:10]
            })
        if len(results) >= limit: break

    return {"results": results, "total_encontrados": len(results)}

def tool_get_tools_info():
    return {
        "ferramentas": [
            {
                "nome": "Processar Planilha",
                "arquivo": "processar_planilha.py",
                "funcao": "Converte arquivos Excel (.xlsx) para CSV (.csv), limpando caracteres invisíveis e formatando valores numéricos e monetários.",
                "entrada": "Arquivo Excel (.xlsx)",
                "saida": "Arquivo CSV (.csv)"
            },
            {
                "nome": "Corretor de CSV",
                "arquivo": "csv_repair_tool.py",
                "funcao": "Corrige quebras de linha acidentais e colunas desalinhadas em arquivos CSV com base na estrutura de âncoras do Planilha Modelo.xlsx.",
                "entrada": "Arquivo CSV quebrado (.csv)",
                "saida": "Arquivo Excel corrigido (.xlsx)"
            },
            {
                "nome": "Divisor de CSV",
                "arquivo": "divisor.py",
                "funcao": "Divide arquivos CSV grandes em arquivos menores com quantidade personalizada de linhas por arquivo.",
                "entrada": "Arquivo CSV (.csv) e Número de Linhas por Arquivo (ex: 100)",
                "saida": "Sub-arquivos CSV particionados"
            }
        ]
    }

def calculate_dashboard_data_legacy(data_inicio, data_fim, selected_cnpjs):
    if not data_inicio or not data_fim:
        return {"error": "dataInicio e dataFim sao obrigatorios"}

    all_franchises = get_franchise_mapping()
    target_franchises = [f for f in all_franchises if f["cnpj"] in selected_cnpjs] if selected_cnpjs else all_franchises
    if not target_franchises:
        return {
            "faturamento": 0, "salesCount": 0, "ticketMedio": 0,
            "vendasDia": [], "vendasHora": [], "rankingGlobal": [],
            "rankingLocal": {}, "rankingSemGiro": [], "capitalTravado": 0,
            "concentracaoNome": "Nenhuma loja", "concentracaoPercentual": 0
        }

    combined_orders = []
    selected_cnpjs_set = set(f["cnpj"] for f in target_franchises)

    with sales_lock:
        for o in sales_cache:
            f_cnpj = o.get("franchiseCnpj")
            if selected_cnpjs_set and (not f_cnpj or f_cnpj not in selected_cnpjs_set):
                continue
            data_str = o.get("data")
            if not data_str: continue
            try:
                parts = data_str.split('-')
                d_obj = datetime(int(parts[2]), int(parts[1]), int(parts[0]))
                if datetime.strptime(data_inicio, "%Y-%m-%d") <= d_obj <= datetime.strptime(data_fim, "%Y-%m-%d"):
                    combined_orders.append(o)
            except Exception: pass

    faturamento = sum(float(o.get("valorTotal", 0.0)) for o in combined_orders)
    sales_count = len(combined_orders)
    ticket_medio = (faturamento / sales_count) if sales_count > 0 else 0.0

    vendas_por_dia = {}
    for o in combined_orders:
        dt = o.get("data")
        val = float(o.get("valorTotal", 0.0))
        vendas_por_dia[dt] = vendas_por_dia.get(dt, 0.0) + val
    chart_vendas_dia = [{"data": k, "valor": round(v, 2)} for k, v in sorted(vendas_por_dia.items())]

    vendas_por_hora = {}
    for o in combined_orders:
        hora_str = o.get("hora", "00:00")
        h = hora_str.split(':')[0]
        vendas_por_hora[h] = vendas_por_hora.get(h, 0) + 1
    chart_vendas_hora = [{"hora": f"{k}h", "qtd": v} for k, v in sorted(vendas_por_hora.items(), key=lambda x: int(x[0]) if x[0].isdigit() else 0)]

    global_product_sales = {}
    local_rankings = {}
    for o in combined_orders:
        f_cnpj = o.get("franchiseCnpj")
        items = o.get("itens", [])
        for item in items:
            ref = item.get("referencia", "S/R")
            desc = item.get("descricao", "Sem descrição")
            qty = float(item.get("quantidade", 1))
            val = float(item.get("valorTotal", 0.0))
            key = (ref, desc)
            if key not in global_product_sales:
                global_product_sales[key] = {"qty": 0, "total": 0.0}
            global_product_sales[key]["qty"] += qty
            global_product_sales[key]["total"] += val

            if f_cnpj:
                if f_cnpj not in local_rankings:
                    local_rankings[f_cnpj] = {}
                if key not in local_rankings[f_cnpj]:
                    local_rankings[f_cnpj][key] = {"qty": 0, "total": 0.0}
                local_rankings[f_cnpj][key]["qty"] += qty
                local_rankings[f_cnpj][key]["total"] += val

    ranking_global = [
        {"ref": k[0], "desc": k[1], "qty": v["qty"], "faturamento": round(v["total"], 2)}
        for k, v in sorted(global_product_sales.items(), key=lambda x: x[1]["total"], reverse=True)[:10]
    ]

    formatted_local_rankings = {}
    for f_cnpj, items_dict in local_rankings.items():
        formatted_local_rankings[f_cnpj] = [
            {"ref": k[0], "desc": k[1], "qty": v["qty"], "faturamento": round(v["total"], 2)}
            for k, v in sorted(items_dict.items(), key=lambda x: x[1]["total"], reverse=True)[:10]
        ]

    slow_moving = tool_get_slow_moving_products(data_fim=data_fim, limit=10).get("slow_moving", [])
    capital_travado = sum(item["custo"] * item["estoque"] for item in slow_moving)

    franchise_totals = {}
    for o in combined_orders:
        f_cnpj = o.get("franchiseCnpj")
        if f_cnpj:
            val = float(o.get("valorTotal", 0.0))
            franchise_totals[f_cnpj] = franchise_totals.get(f_cnpj, 0.0) + val

    concentracao_nome = "Sem vendas"
    concentracao_percentual = 0.0
    if franchise_totals:
        top_f_cnpj = max(franchise_totals, key=franchise_totals.get)
        top_f_val = franchise_totals[top_f_cnpj]
        top_f_name = cnpj_names.get(top_f_cnpj)
        if not top_f_name:
            for m in all_franchises:
                if m["cnpj"] == top_f_cnpj:
                    top_f_name = m["name"]
                    break
        concentracao_nome = top_f_name or f"CNPJ {top_f_cnpj}"
        concentracao_percentual = round((top_f_val / faturamento * 100), 1) if faturamento > 0 else 0.0

    return {
        "faturamento": round(faturamento, 2),
        "salesCount": sales_count,
        "ticketMedio": round(ticket_medio, 2),
        "vendasDia": chart_vendas_dia,
        "vendasHora": chart_vendas_hora,
        "rankingGlobal": ranking_global,
        "rankingLocal": formatted_local_rankings,
        "rankingSemGiro": slow_moving,
        "capitalTravado": round(capital_travado, 2),
        "concentracaoNome": concentracao_nome,
        "concentracaoPercentual": concentracao_percentual,
        "dataQualityScore": 100,
        "lastSync": datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    }

def get_cached_slow_moving(data_fim, selected):
    cache_key = (bi_data_revision, data_fim, tuple(sorted(selected)))
    with bi_slow_cache_lock:
        cached = bi_slow_cache.get(cache_key)
    if cached is not None:
        return cached
    result = tool_get_slow_moving_products(data_fim, 10, list(selected)).get("slow_moving", [])
    with bi_slow_cache_lock:
        if len(bi_slow_cache) >= 48:
            bi_slow_cache.pop(next(iter(bi_slow_cache)))
        bi_slow_cache[cache_key] = result
    return result

def aggregate_dashboard_sales(range_start, range_end, selected, granularity):
    daily = {}
    hourly = {}
    global_products = {}
    local_products = {}
    franchise_totals = {}
    revenue = 0.0
    sales_count = 0
    with sales_lock:
        daily_ready = sales_daily_ready
        if daily_ready:
            first = bisect_left(sales_daily_dates, range_start)
            last = bisect_right(sales_daily_dates, range_end.replace(hour=23, minute=59, second=59))
            day_summaries = list(sales_daily_index[first:last])
    if not daily_ready:
        for order in filter_sales(
            range_start.strftime("%Y-%m-%d"), range_end.strftime("%Y-%m-%d"), selected
        ):
            sale_date = parse_sale_date(order)
            if granularity == "week":
                period_date = sale_date - timedelta(days=sale_date.weekday())
            elif granularity == "month":
                period_date = sale_date.replace(day=1)
            else:
                period_date = sale_date
            period_key = period_date.strftime("%Y-%m-%d")
            cnpj = order.get("franchiseCnpj")
            value = safe_float(order.get("valorTotal"))
            revenue += value
            sales_count += 1
            daily[period_key] = daily.get(period_key, 0.0) + value
            franchise_totals[cnpj] = franchise_totals.get(cnpj, 0.0) + value
            hour = str(order.get("horario") or order.get("hora") or "00:00").split(":")[0]
            if hour.isdigit():
                hourly[hour] = hourly.get(hour, 0.0) + value
            local = local_products.setdefault(cnpj, {})
            for item in order.get("itens") or []:
                _product_id, ref, desc = get_item_identity(item)
                key = (ref, desc)
                quantity = safe_float(item.get("quantidade"), 1.0)
                total = safe_float(item.get("valorTotal"))
                aggregate = global_products.setdefault(key, {"qty": 0.0, "total": 0.0})
                aggregate["qty"] += quantity
                aggregate["total"] += total
                local_aggregate = local.setdefault(key, {"qty": 0.0, "total": 0.0})
                local_aggregate["qty"] += quantity
                local_aggregate["total"] += total
        return revenue, sales_count, daily, hourly, global_products, local_products, franchise_totals

    for sale_date, day in day_summaries:
        if granularity == "week":
            period_date = sale_date - timedelta(days=sale_date.weekday())
        elif granularity == "month":
            period_date = sale_date.replace(day=1)
        else:
            period_date = sale_date
        period_key = period_date.strftime("%Y-%m-%d")
        for cnpj, store in day["stores"].items():
            if selected and cnpj not in selected:
                continue
            store_revenue = store["revenue"]
            revenue += store_revenue
            sales_count += store["count"]
            daily[period_key] = daily.get(period_key, 0.0) + store_revenue
            franchise_totals[cnpj] = franchise_totals.get(cnpj, 0.0) + store_revenue
            for hour, value in store["hours"].items():
                hourly[hour] = hourly.get(hour, 0.0) + value
            local = local_products.setdefault(cnpj, {})
            for key, values in store["products"].items():
                aggregate = global_products.setdefault(key, {"qty": 0.0, "total": 0.0})
                aggregate["qty"] += values[0]
                aggregate["total"] += values[1]
                local_aggregate = local.setdefault(key, {"qty": 0.0, "total": 0.0})
                local_aggregate["qty"] += values[0]
                local_aggregate["total"] += values[1]
    return revenue, sales_count, daily, hourly, global_products, local_products, franchise_totals

def calculate_dashboard_data(data_inicio, data_fim, selected_cnpjs):
    if not data_inicio or not data_fim:
        return {"error": "dataInicio e dataFim sao obrigatorios"}
    try:
        range_start = datetime.strptime(data_inicio, "%Y-%m-%d")
        range_end = datetime.strptime(data_fim, "%Y-%m-%d")
    except (TypeError, ValueError):
        return {"error": "Intervalo de datas invalido"}
    if range_start > range_end:
        return {"error": "A data inicial nao pode ser posterior a data final"}
    range_days = (range_end - range_start).days + 1
    chart_granularity = "day" if range_days <= 120 else ("week" if range_days <= 730 else "month")

    all_franchises = get_franchise_mapping()
    target_franchises = [
        franchise for franchise in all_franchises
        if not selected_cnpjs or franchise["cnpj"] in selected_cnpjs
    ]
    selected = {franchise["cnpj"] for franchise in target_franchises}
    (
        revenue, sales_count, daily, hourly, global_products, local_products, franchise_totals
    ) = aggregate_dashboard_sales(range_start, range_end, selected, chart_granularity)

    def rank(products):
        return [
            {"ref": key[0], "desc": key[1], "qty": round(value["qty"], 2), "total": round(value["total"], 2)}
            for key, value in sorted(products.items(), key=lambda pair: pair[1]["total"], reverse=True)[:10]
        ]

    slow_moving = get_cached_slow_moving(data_fim, selected)
    concentration_name = "Sem vendas"
    concentration_percent = 0.0
    if franchise_totals and revenue > 0:
        top_cnpj = max(franchise_totals, key=franchise_totals.get)
        concentration_name = cnpj_names.get(top_cnpj) or next(
            (franchise["name"] for franchise in all_franchises if franchise["cnpj"] == top_cnpj),
            top_cnpj,
        )
        concentration_percent = round(franchise_totals[top_cnpj] / revenue * 100, 1)

    with bi_data_lock:
        product_count = len(inventory_cache.get("products", {}))
        stock_count = len(inventory_cache.get("stock", {}))
        inventory_synced_at = inventory_cache.get("syncedAt")
    coverage_start, coverage_end = sales_cache_coverage()

    def chart_label(key):
        parsed = datetime.strptime(key, "%Y-%m-%d")
        if chart_granularity == "month":
            return parsed.strftime("%m/%Y")
        if chart_granularity == "week":
            return f"Sem. {parsed:%d/%m}"
        return parsed.strftime("%d/%m")

    return {
        "faturamento": round(revenue, 2),
        "salesCount": sales_count,
        "ticketMedio": round(revenue / sales_count, 2) if sales_count else 0,
        "vendasDia": [
            {"label": chart_label(key), "value": round(value, 2)}
            for key, value in sorted(daily.items())
        ],
        "chartGranularity": chart_granularity,
        "vendasHora": [
            {"label": f"{key}h", "value": round(value, 2)}
            for key, value in sorted(hourly.items(), key=lambda pair: int(pair[0]))
        ],
        "rankingGlobal": rank(global_products),
        "rankingLocal": {cnpj: rank(products) for cnpj, products in local_products.items()},
        "rankingSemGiro": slow_moving,
        "capitalTravado": round(sum(item["custo"] * item["estoque"] for item in slow_moving), 2),
        "concentracaoNome": concentration_name,
        "concentracaoPercentual": concentration_percent,
        "dataQualityScore": 100 if product_count and stock_count else (70 if product_count else 45),
        "catalogProductCount": product_count,
        "stockPositionCount": stock_count,
        "lastSync": inventory_synced_at or datetime.now().isoformat(),
        "historyCoverageStart": coverage_start.strftime("%Y-%m-%d") if coverage_start else None,
        "historyCoverageEnd": coverage_end.strftime("%Y-%m-%d") if coverage_end else None,
        "historyTargetStart": BI_HISTORY_EARLIEST_DATE.strftime("%Y-%m-%d"),
        "historyBackfillComplete": bool(sales_history_meta.get("complete")),
        "syncStatus": dict(bi_sync_status),
    }

def run_gemini_chat_loop(messages, ui_context=None):
    gemini_token = get_gemini_token()
    if not gemini_token:
        raise Exception("A chave GEMINI_TOKEN não foi configurada no arquivo .env.")

    contents = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        gemini_role = "model" if role in ["assistant", "system"] else "user"
        contents.append({
            "role": gemini_role,
            "parts": [{"text": content}]
        })

    tools = [{
        "functionDeclarations": [
            {
                "name": "get_franchises_list",
                "description": "Retorna a lista de todas as filiais/franquias da rede contendo o nome e CNPJ de cada uma."
            },
            {
                "name": "get_franchise_performance",
                "description": "Retorna o faturamento total, quantidade de vendas e ticket médio individual de CADA filial no período.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "data_inicio": {"type": "STRING", "description": "Data inicial YYYY-MM-DD."},
                        "data_fim": {"type": "STRING", "description": "Data final YYYY-MM-DD."}
                    }
                }
            },
            {
                "name": "get_general_stats",
                "description": "Retorna faturamento, quantidade, ticket médio, série diária, melhor dia de vendas, menor dia com vendas e cobertura histórica do cache em um período. Use para perguntas sobre datas, picos, comparações e evolução de vendas.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "data_inicio": {"type": "STRING", "description": "Data inicial YYYY-MM-DD."},
                        "data_fim": {"type": "STRING", "description": "Data final YYYY-MM-DD."},
                        "cnpjs": {"type": "STRING", "description": "CNPJs separados por vírgula."}
                    }
                }
            },
            {
                "name": "get_top_products",
                "description": "Retorna o ranking dos produtos mais vendidos por faturamento e quantidade.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "data_inicio": {"type": "STRING", "description": "Data inicial YYYY-MM-DD."},
                        "data_fim": {"type": "STRING", "description": "Data final YYYY-MM-DD."},
                        "cnpjs": {"type": "STRING", "description": "CNPJs separados por vírgula."},
                        "limit": {"type": "NUMBER", "description": "Quantidade máxima de produtos."}
                    }
                }
            },
            {
                "name": "get_slow_moving_products",
                "description": "Retorna os produtos de menor giro (estoque parado e capital travado).",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "data_fim": {"type": "STRING", "description": "Data de referência YYYY-MM-DD."},
                        "limit": {"type": "NUMBER", "description": "Limite de resultados."}
                    }
                }
            },
            {
                "name": "get_product_pairs",
                "description": "Retorna os pares/duplas de produtos mais comprados juntos em uma mesma venda (cesta de compras).",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "data_inicio": {"type": "STRING", "description": "Data inicial YYYY-MM-DD."},
                        "data_fim": {"type": "STRING", "description": "Data final YYYY-MM-DD."},
                        "limit": {"type": "NUMBER", "description": "Quantidade de pares."}
                    }
                }
            },
            {
                "name": "get_pedidos_summary",
                "description": "Retorna o resumo geral de pedidos (quantidade total, pedidos ativos, por situação, fornecedores e valor estimado)."
            },
            {
                "name": "search_pedidos",
                "description": "Busca pedidos por código, nome do fornecedor, franquia, produto ou situação.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "query": {"type": "STRING", "description": "Termo de busca (código, fornecedor, franquia ou produto)."},
                        "status": {"type": "STRING", "description": "Filtro por situação (ex: 'Em Separação', 'Enviado', 'Finalizado')."},
                        "limit": {"type": "NUMBER", "description": "Limite de resultados."}
                    }
                }
            },
            {
                "name": "get_chamados_summary",
                "description": "Retorna o resumo geral de chamados de suporte (total, chamados ativos, aguardando suporte, aguardando franqueado, categorias e atendentes)."
            },
            {
                "name": "search_chamados",
                "description": "Busca chamados de suporte por código, assunto, solicitante, atendente, categoria ou status.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "query": {"type": "STRING", "description": "Termo de busca (código, assunto, pessoa ou franquia)."},
                        "status": {"type": "STRING", "description": "Filtro por status (ex: 'open', 'inAttendance', 'awaitingFeedback', 'finished')."},
                        "category": {"type": "STRING", "description": "Filtro por categoria funcional."},
                        "limit": {"type": "NUMBER", "description": "Limite de resultados."}
                    }
                }
            },
            {
                "name": "get_tools_info",
                "description": "Retorna informações e instruções detalhadas de como usar as Ferramentas de Planilha (Processar Planilha, Corretor de CSV e Divisor de CSV)."
            }
        ]
    }]

    context_text = ""
    if isinstance(ui_context, dict) and ui_context:
        context_text = (
            "\nContexto atual da interface (use quando o usuário disser 'este período', 'aqui' ou não repetir filtros):\n"
            + json.dumps(ui_context, ensure_ascii=False, separators=(",", ":"))
        )
    coverage_start, coverage_end = sales_cache_coverage()
    coverage_text = (
        f"\nO cache de vendas disponível cobre {coverage_start:%d/%m/%Y} a {coverage_end:%d/%m/%Y}. "
        if coverage_start and coverage_end else "\nO cache de vendas ainda está vazio. "
    )
    coverage_text += (
        f"O histórico anterior ainda está sendo ampliado em segundo plano até {BI_HISTORY_EARLIEST_DATE:%d/%m/%Y}."
        if not sales_history_meta.get("complete") else "O histórico disponível já foi integralmente sincronizado."
    )
    system_instruction = {
        "parts": [{
            "text": (
                "Você é o Assistente Global do Monitores Central, uma IA especializada em inteligência de negócios, "
                "gestão de pedidos, chamados de suporte e utilização de ferramentas de planilhas para a rede Santoline.\n"
                "Seu objetivo é ajudar o franqueador e gerentes a entenderem dados em tempo real e executarem tarefas com máxima clareza.\n"
                "Sempre que o usuário fizer perguntas que exijam dados de vendas, pedidos, chamados ou ferramentas, DEVE invocar a função correspondente.\n"
                "Sempre responda em Português do Brasil de forma clara e objetiva. "
                "Nunca diga que não consegue calcular algo antes de consultar as ferramentas disponíveis. "
                "Quando a pergunta for anterior ao início da cobertura, avise que o histórico ainda está sendo sincronizado."
                + coverage_text + context_text
            )
        }]
    }

    model_urls = [
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={gemini_token}",
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={gemini_token}",
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={gemini_token}"
    ]

    for attempt in range(5):
        payload = {
            "contents": contents,
            "tools": tools,
            "systemInstruction": system_instruction
        }
        req_data = json.dumps(payload).encode('utf-8')
        res_data = None
        last_error = None

        for url in model_urls:
            try:
                req = urllib.request.Request(
                    url,
                    data=req_data,
                    headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=35) as response:
                    res_data = json.loads(response.read().decode('utf-8'))
                    break
            except Exception as err:
                last_error = err
                continue

        if not res_data:
            raise Exception(f"Erro na comunicacao com a API Gemini: {last_error}")

        candidates = res_data.get("candidates", [])
        if not candidates:
            return "Desculpe, não foi possível gerar uma resposta no momento."

        first_cand = candidates[0]
        content_obj = first_cand.get("content", {})
        parts = content_obj.get("parts", [])

        func_call = None
        text_response = ""
        for p in parts:
            if "functionCall" in p:
                func_call = p["functionCall"]
                break
            elif "text" in p:
                text_response += p["text"]

        if not func_call:
            return text_response

        func_name = func_call.get("name")
        args = func_call.get("args", {})
        print(f"[AI ASSISTANT] Gemini solicitou a execução da função '{func_name}' com argumentos: {args}")

        result = {}
        try:
            if func_name == "get_franchises_list": result = tool_get_franchises_list()
            elif func_name == "get_franchise_performance": result = tool_get_franchise_performance(**args)
            elif func_name == "get_general_stats": result = tool_get_general_stats(**args)
            elif func_name == "get_top_products": result = tool_get_top_products(**args)
            elif func_name == "get_slow_moving_products": result = tool_get_slow_moving_products(**args)
            elif func_name == "get_product_pairs": result = tool_get_product_pairs(**args)
            elif func_name == "get_pedidos_summary": result = tool_get_pedidos_summary()
            elif func_name == "search_pedidos": result = tool_search_pedidos(**args)
            elif func_name == "get_chamados_summary": result = tool_get_chamados_summary()
            elif func_name == "search_chamados": result = tool_search_chamados(**args)
            elif func_name == "get_tools_info": result = tool_get_tools_info()
            else: result = {"error": f"Função {func_name} não encontrada."}
        except Exception as e:
            print(f"[AI ASSISTANT ERROR] Falha ao executar {func_name}: {e}")
            result = {"error": str(e)}

        contents.append({
            "role": "model",
            "parts": [{"functionCall": func_call}]
        })
        contents.append({
            "role": "function",
            "parts": [{
                "functionResponse": {
                    "name": func_name,
                    "response": result
                }
            }]
        })

    return "Não foi possível concluir o raciocínio após múltiplas chamadas de ferramentas."


# ==============================================================================
# UNIFIED REQUEST HANDLER
# ==============================================================================

class UnifiedRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence logs to avoid terminal spam
        pass

    def translate_path(self, path):
        # Map /chamados/ routes to app_chamados/ and everything else to app_pedidos/
        # Strip query parameters or hashes
        clean_path = path.split('?', 1)[0].split('#', 1)[0]
        
        if clean_path == "/shared-theme.css":
            return os.path.join(MONITOR_APP_DIR, "shared-theme.css")

        if clean_path.startswith("/dashboard/"):
            rel_path = clean_path[len("/dashboard/"):]
            if not rel_path or rel_path.endswith("/"):
                rel_path += "index.html"
            return os.path.join(DASHBOARD_DIR, rel_path)
            
        elif clean_path == "/dashboard":
            return os.path.join(DASHBOARD_DIR, "index.html")

        elif clean_path.startswith("/chamados/"):
            rel_path = clean_path[len("/chamados/"):]
            if not rel_path or rel_path.endswith("/"):
                rel_path += "index.html"
            return os.path.join(CHAMADOS_DIR, rel_path)
            
        elif clean_path == "/chamados":
            return os.path.join(CHAMADOS_DIR, "index.html")

        else:
            rel_path = clean_path.lstrip("/")
            if not rel_path or rel_path.endswith("/"):
                rel_path += "index.html"
            return os.path.join(PEDIDOS_DIR, rel_path)

    def do_GET(self):
        # ----------------------------------------------------
        # PEDIDOS ENDPOINTS
        # ----------------------------------------------------
        if self.path == "/api/pedidos/list":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            def get_active_orders():
                with pedidos_state_lock:
                    cached_orders = load_json_file(PEDIDOS_STATE_FILE, {})
                return [o for o in cached_orders.values() if not is_inactive_order(o)]
            self.wfile.write(cached_json_bytes("pedidos-list", pedidos_data_revision, get_active_orders))

        elif self.path == "/api/pedidos/notificacoes":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(cached_json_bytes(
                "pedidos-notificacoes",
                pedidos_data_revision,
                lambda: load_json_file(PEDIDOS_NOTIFICATIONS_FILE, [])
            ))

        elif self.path == "/api/pedidos/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            status = {**pedidos_sync_status, "revision": pedidos_data_revision}
            self.wfile.write(json.dumps(status, ensure_ascii=False).encode("utf-8"))

        elif self.path == "/api/pedidos/preferencias":
            prefs = load_json_file(PEDIDOS_PREFS_FILE, PEDIDOS_DEFAULT_PREFS.copy())
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({**PEDIDOS_DEFAULT_PREFS, **prefs}, ensure_ascii=False).encode("utf-8"))

        # ----------------------------------------------------
        # DASHBOARD & BI ENDPOINTS
        # ----------------------------------------------------
        elif self.path == "/api/dashboard/status":
            coverage_start, coverage_end = sales_cache_coverage()
            with bi_data_lock:
                status = {
                    **bi_sync_status,
                    "lastSync": inventory_cache.get("syncedAt"),
                    "catalogProductCount": len(inventory_cache.get("products", {})),
                    "stockPositionCount": len(inventory_cache.get("stock", {})),
                    "historyCoverageStart": coverage_start.strftime("%Y-%m-%d") if coverage_start else None,
                    "historyCoverageEnd": coverage_end.strftime("%Y-%m-%d") if coverage_end else None,
                    "historyTargetStart": BI_HISTORY_EARLIEST_DATE.strftime("%Y-%m-%d"),
                    "historyBackfillComplete": bool(sales_history_meta.get("complete")),
                    "salesIndexReady": bool(sales_daily_ready),
                    "source": "API Varejo Online",
                }
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(status, ensure_ascii=False).encode("utf-8"))

        elif self.path.startswith("/api/dashboard"):
            parsed_url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed_url.query)
            data_inicio = query.get("dataInicio", [None])[0]
            data_fim = query.get("dataFim", [None])[0]
            cnpjs_str = query.get("cnpjs", [""])[0]
            selected_cnpjs = [c.strip() for c in cnpjs_str.split(",") if c.strip()]

            cache_key = (bi_data_revision, data_inicio, data_fim, tuple(sorted(selected_cnpjs)))
            with bi_dashboard_cache_lock:
                data = bi_dashboard_cache.get(cache_key)
            if data is None:
                data = calculate_dashboard_data(data_inicio, data_fim, selected_cnpjs)
                with bi_dashboard_cache_lock:
                    if len(bi_dashboard_cache) >= 32:
                        bi_dashboard_cache.pop(next(iter(bi_dashboard_cache)))
                    bi_dashboard_cache[cache_key] = data
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

        elif self.path == "/api/franchises":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(tool_get_franchises_list()["franchises"], ensure_ascii=False).encode('utf-8'))

        # ----------------------------------------------------
        # CHAMADOS ENDPOINTS
        # ----------------------------------------------------
        elif self.path == "/api/chamados/list":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            def get_active_tickets():
                with chamados_state_lock:
                    cached = load_json_file(CHAMADOS_STATE_FILE, {})
                return [t for t in cached.values() if is_monitorable_ticket(t)]
            self.wfile.write(cached_json_bytes("chamados-list", chamados_data_revision, get_active_tickets))

        elif self.path == "/api/chamados/notificacoes":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(cached_json_bytes(
                "chamados-notificacoes",
                chamados_data_revision,
                lambda: load_json_file(CHAMADOS_NOTIFICATIONS_FILE, [])
            ))

        elif self.path == "/api/chamados/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            status = {**chamados_sync_status, "revision": chamados_data_revision}
            self.wfile.write(json.dumps(status, ensure_ascii=False).encode('utf-8'))

        elif self.path == "/api/chamados/feedback":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(cached_json_bytes("chamados-feedback", chamados_data_revision, get_feedback_stats))

        elif self.path == "/api/chamados/preferencias":
            prefs = load_json_file(CHAMADOS_PREFS_FILE, CHAMADOS_DEFAULT_PREFS.copy())
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({**CHAMADOS_DEFAULT_PREFS, **prefs}, ensure_ascii=False).encode("utf-8"))

        # ----------------------------------------------------
        # STATIC FILES FALLBACK
        # ----------------------------------------------------
        else:
            # Check for redirect from /chamados to /chamados/
            clean_p = self.path.split('?', 1)[0].split('#', 1)[0]
            if clean_p == "/chamados":
                self.send_response(301)
                self.send_header("Location", "/chamados/")
                self.end_headers()
                return
            elif clean_p == "/dashboard":
                self.send_response(301)
                self.send_header("Location", "/dashboard/")
                self.end_headers()
                return

            super().do_GET()

    def end_headers(self):
        # Disable cache for API endpoints
        if self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_POST(self):
        # ----------------------------------------------------
        # PEDIDOS SYNC POST
        # ----------------------------------------------------
        if self.path in ("/api/pedidos/preferencias", "/api/chamados/preferencias"):
            try:
                content_length = min(int(self.headers.get("Content-Length", "0")), 65536)
                payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("Preferencias devem ser um objeto JSON")
                if self.path == "/api/pedidos/preferencias":
                    prefs = {**PEDIDOS_DEFAULT_PREFS, **payload}
                    save_json_file(PEDIDOS_PREFS_FILE, prefs)
                else:
                    prefs = {**CHAMADOS_DEFAULT_PREFS, **payload}
                    save_json_file(CHAMADOS_PREFS_FILE, prefs)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "preferences": prefs}, ensure_ascii=False).encode("utf-8"))
            except Exception as err:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(err)}, ensure_ascii=False).encode("utf-8"))

        elif self.path == "/api/pedidos/atualizar":
            if pedidos_sync_lock.acquire(blocking=False):
                try:
                    set_pedidos_sync_status(True, "sincronizando dados")
                    try:
                        recent_success = poll_orders_range(PEDIDOS_MANUAL_REFRESH_DAYS)
                        active_dates = get_active_order_creation_dates()
                        active_batch, _ = pick_rotating_batch(active_dates, 0, PEDIDOS_ACTIVE_ORDER_DATE_BATCH_SIZE)
                        active_success = poll_orders_dates(active_batch, f"lote de {len(active_batch)} datas com pedidos ativos")
                        success = recent_success or active_success
                    finally:
                        set_pedidos_sync_status(False)
                finally:
                    pedidos_sync_lock.release()
            else:
                success = True
                print("[SYNC] Sincronizacao de pedidos ja em andamento.")
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": success, "revision": pedidos_data_revision}).encode("utf-8"))

        # ----------------------------------------------------
        # CHAMADOS SYNC POST
        # ----------------------------------------------------
        elif self.path == "/api/chamados/atualizar":
            success = False
            if chamados_sync_lock.acquire(blocking=False):
                try:
                    set_chamados_sync_status(True, "sincronizando dados")
                    try:
                        success = sync_tickets_data(
                            full_import=False,
                            lookback_days=TICKETS_RECENT_LOOKBACK_DAYS,
                            detail_refresh_seconds=DETAIL_REFRESH_SECONDS,
                            collect_feedback=True
                        )
                    finally:
                        set_chamados_sync_status(False)
                finally:
                    chamados_sync_lock.release()
            else:
                success = True
                print("[SYNC] Sincronizacao de chamados ja em andamento.")

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": success, "revision": chamados_data_revision}).encode("utf-8"))

        elif self.path == "/api/dashboard/atualizar":
            started = not bi_sync_status.get("is_syncing")
            if started:
                threading.Thread(target=sync_bi_inventory, daemon=True).start()
            self.send_response(202)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "started": started}).encode("utf-8"))

        elif self.path == "/api/chat":
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                payload = json.loads(post_data.decode('utf-8'))
                messages = payload.get("messages", [])
                ui_context = payload.get("context", {})
                
                ai_response = run_gemini_chat_loop(messages, ui_context)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"response": ai_response}, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                import traceback
                traceback.print_exc()
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}, ensure_ascii=False).encode('utf-8'))

        else:
            self.send_error(404, "Endpoint nao encontrado")

import ctypes

def is_process_alive(pid):
    if pid <= 0:
        return False
    if sys.platform == 'win32':
        try:
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            SYNCHRONIZE = 0x0010
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid)
            if not handle:
                return False
            exit_code = ctypes.c_ulong()
            success = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            ctypes.windll.kernel32.CloseHandle(handle)
            if not success:
                return False
            return exit_code.value == 259 # STILL_ACTIVE
        except Exception:
            return True
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

def monitor_parent_process():
    if os.environ.get("MONITOR_DISABLE_PARENT_WATCH") == "1":
        return
    try:
        parent_pid = os.getppid()
        if parent_pid <= 1:
            return
        
        def check_loop():
            time.sleep(5)
            while True:
                time.sleep(3)
                if not is_process_alive(parent_pid):
                    sys.stdout.write("[INFO] Processo pai encerrou. Encerrando o servidor unificado...\n")
                    sys.stdout.flush()
                    os._exit(0)

        t = threading.Thread(target=check_loop, daemon=True)
        t.start()
    except Exception as e:
        sys.stdout.write(f"[WARN] Falha ao iniciar monitor de processo pai: {e}\n")
        sys.stdout.flush()

def start_server():
    # Monitor parent process to prevent zombie servers on exit
    monitor_parent_process()

    # Load BI Sales & Products Cache
    load_sales_from_json_file()
    load_products_from_json_file()

    bi_index_thread = threading.Thread(target=build_sales_daily_index_background, daemon=True)
    bi_index_thread.start()

    # Start polling loops
    pedidos_thread = threading.Thread(target=pedidos_poll_loop, daemon=True)
    pedidos_thread.start()

    chamados_thread = threading.Thread(target=chamados_poll_loop, daemon=True)
    chamados_thread.start()

    bi_thread = threading.Thread(target=bi_poll_loop, daemon=True)
    bi_thread.start()

    bi_history_thread = threading.Thread(target=bi_history_backfill_loop, daemon=True)
    bi_history_thread.start()

    # Start Unified HTTP Server
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), UnifiedRequestHandler) as httpd:
        print(f"\n==================================================")
        print(f" Servidor Unificado iniciado com SUCESSO!")
        print(f" Porta: {PORT}")
        print(f"==================================================\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nEncerrando o servidor...")
            httpd.shutdown()

if __name__ == "__main__":
    start_server()
