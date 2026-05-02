/*
 * Process Tree Visualizer - Core Backend (Windows)
 * ==================================================
 * Extracts real process data from Windows using the Tool Help API,
 * builds a parent-child tree, and outputs structured JSON.
 *
 * Compilation: gcc process_tree.c -o process_tree.exe -lpsapi
 * Usage:       process_tree.exe > process.json
 *
 * Author: Process Tree Visualizer Project
 */

#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ============================================================
 * Constants & Configuration
 * ============================================================ */
#define MAX_PROCESSES    4096
#define MAX_NAME_LEN     260
#define HASH_TABLE_SIZE  8191   /* Prime number for better distribution */

/* ============================================================
 * Data Structures
 * ============================================================ */

/* Represents a single process entry */
typedef struct ProcessInfo {
    DWORD pid;
    DWORD ppid;
    char  name[MAX_NAME_LEN];
    char  status[32];        /* Running, Sleeping, Zombie, Unknown */
    char  priority[32];      /* Priority class: Idle, Normal, High, etc. */
    DWORD threadCount;
    DWORD handleCount;
    SIZE_T memoryUsageKB;    /* Working set size in KB */
    ULONGLONG cpuTimeMs;     /* Total CPU time in milliseconds (kernel + user) */
    int   childCount;
    int   childIndices[256]; /* Indices of children in the process array */
} ProcessInfo;

/* Hash table node for O(1) PID -> index lookup */
typedef struct HashNode {
    DWORD pid;
    int   index;
    struct HashNode *next;
} HashNode;

/* ============================================================
 * Global State
 * ============================================================ */
static ProcessInfo g_processes[MAX_PROCESSES];
static int         g_processCount = 0;
static HashNode   *g_hashTable[HASH_TABLE_SIZE];

/* ============================================================
 * Hash Table Implementation (for O(n) tree construction)
 * ============================================================ */

/* Simple hash function for DWORD PIDs */
static unsigned int hash_pid(DWORD pid) {
    return pid % HASH_TABLE_SIZE;
}

/* Insert a PID -> index mapping into the hash table */
static void hash_insert(DWORD pid, int index) {
    unsigned int h = hash_pid(pid);
    HashNode *node = (HashNode *)malloc(sizeof(HashNode));
    if (!node) {
        fprintf(stderr, "Error: Memory allocation failed for hash node\n");
        return;
    }
    node->pid   = pid;
    node->index = index;
    node->next  = g_hashTable[h];
    g_hashTable[h] = node;
}

/* Look up the array index for a given PID; returns -1 if not found */
static int hash_lookup(DWORD pid) {
    unsigned int h = hash_pid(pid);
    HashNode *node = g_hashTable[h];
    while (node) {
        if (node->pid == pid) return node->index;
        node = node->next;
    }
    return -1;
}

/* Free all hash table memory */
static void hash_free(void) {
    for (int i = 0; i < HASH_TABLE_SIZE; i++) {
        HashNode *node = g_hashTable[i];
        while (node) {
            HashNode *next = node->next;
            free(node);
            node = next;
        }
        g_hashTable[i] = NULL;
    }
}

/* ============================================================
 * Determine Process Status
 * ============================================================
 * On Windows we check if the process handle can be opened and
 * inspect thread wait reasons to approximate status:
 *   - "Running"  : has active threads
 *   - "Suspended": all threads are suspended
 *   - "Zombie"   : process exited but entry still present
 *   - "Unknown"  : cannot be inspected (access denied, etc.)
 */
static void get_process_status(DWORD pid, char *statusBuf, size_t bufLen) {
    if (pid == 0) {
        strncpy(statusBuf, "Running", bufLen);
        return;
    }

    HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!hProcess) {
        /* If we can't open the process, check if it's a system-level one */
        DWORD err = GetLastError();
        if (err == ERROR_ACCESS_DENIED) {
            strncpy(statusBuf, "Running", bufLen);
        } else {
            strncpy(statusBuf, "Zombie", bufLen);
        }
        return;
    }

    /* Check if the process has exited */
    DWORD exitCode;
    if (GetExitCodeProcess(hProcess, &exitCode)) {
        if (exitCode != STILL_ACTIVE) {
            strncpy(statusBuf, "Zombie", bufLen);
            CloseHandle(hProcess);
            return;
        }
    }

    /* Try to check thread states to determine if sleeping or running */
    HANDLE hThreadSnap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (hThreadSnap != INVALID_HANDLE_VALUE) {
        THREADENTRY32 te;
        te.dwSize = sizeof(THREADENTRY32);
        int totalThreads = 0;
        int waitingThreads = 0;

        if (Thread32First(hThreadSnap, &te)) {
            do {
                if (te.th32OwnerProcessID == pid) {
                    totalThreads++;
                    /* Check if thread is in a wait state */
                    HANDLE hThread = OpenThread(THREAD_QUERY_INFORMATION, FALSE, te.th32ThreadID);
                    if (hThread) {
                        /* If we can query the thread, count it */
                        DWORD suspendCount = SuspendThread(hThread);
                        if (suspendCount != (DWORD)-1) {
                            if (suspendCount > 0) {
                                waitingThreads++;
                            }
                            ResumeThread(hThread);
                        }
                        CloseHandle(hThread);
                    }
                }
            } while (Thread32Next(hThreadSnap, &te));
        }
        CloseHandle(hThreadSnap);

        if (totalThreads > 0 && waitingThreads == totalThreads) {
            strncpy(statusBuf, "Sleeping", bufLen);
        } else {
            strncpy(statusBuf, "Running", bufLen);
        }
    } else {
        strncpy(statusBuf, "Running", bufLen);
    }

    CloseHandle(hProcess);
}

/* ============================================================
 * Get Process Priority Class
 * ============================================================ */
static void get_process_priority(DWORD pid, char *priBuf, size_t bufLen) {
    if (pid == 0 || pid == 4) {
        strncpy(priBuf, "System", bufLen);
        return;
    }
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, pid);
    if (!hProcess) {
        strncpy(priBuf, "Unknown", bufLen);
        return;
    }
    DWORD priClass = GetPriorityClass(hProcess);
    CloseHandle(hProcess);
    switch (priClass) {
        case IDLE_PRIORITY_CLASS:         strncpy(priBuf, "Idle", bufLen); break;
        case BELOW_NORMAL_PRIORITY_CLASS: strncpy(priBuf, "Below Normal", bufLen); break;
        case NORMAL_PRIORITY_CLASS:       strncpy(priBuf, "Normal", bufLen); break;
        case ABOVE_NORMAL_PRIORITY_CLASS: strncpy(priBuf, "Above Normal", bufLen); break;
        case HIGH_PRIORITY_CLASS:         strncpy(priBuf, "High", bufLen); break;
        case REALTIME_PRIORITY_CLASS:     strncpy(priBuf, "Realtime", bufLen); break;
        default:                          strncpy(priBuf, "Unknown", bufLen); break;
    }
}

/* ============================================================
 * Get Additional Process Info (memory, handles, CPU time)
 * ============================================================ */
static void get_process_details(ProcessInfo *pInfo) {
    HANDLE hProcess = OpenProcess(
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
        FALSE, pInfo->pid
    );
    if (hProcess) {
        PROCESS_MEMORY_COUNTERS pmc;
        if (GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
            pInfo->memoryUsageKB = pmc.WorkingSetSize / 1024;
        }

        /* Get CPU time (kernel + user) */
        FILETIME ftCreate, ftExit, ftKernel, ftUser;
        if (GetProcessTimes(hProcess, &ftCreate, &ftExit, &ftKernel, &ftUser)) {
            ULARGE_INTEGER kTime, uTime;
            kTime.LowPart  = ftKernel.dwLowDateTime;
            kTime.HighPart = ftKernel.dwHighDateTime;
            uTime.LowPart  = ftUser.dwLowDateTime;
            uTime.HighPart = ftUser.dwHighDateTime;
            /* FILETIME is in 100-nanosecond intervals, convert to ms */
            pInfo->cpuTimeMs = (kTime.QuadPart + uTime.QuadPart) / 10000;
        }

        CloseHandle(hProcess);
    }
}

/* ============================================================
 * Step 1: Enumerate All Processes
 * ============================================================ */
static int enumerate_processes(void) {
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "Error: CreateToolhelp32Snapshot failed (error %lu)\n",
                GetLastError());
        return -1;
    }

    PROCESSENTRY32 pe;
    pe.dwSize = sizeof(PROCESSENTRY32);

    if (!Process32First(hSnapshot, &pe)) {
        fprintf(stderr, "Error: Process32First failed (error %lu)\n",
                GetLastError());
        CloseHandle(hSnapshot);
        return -1;
    }

    g_processCount = 0;
    memset(g_hashTable, 0, sizeof(g_hashTable));

    do {
        if (g_processCount >= MAX_PROCESSES) break;

        ProcessInfo *p = &g_processes[g_processCount];
        p->pid         = pe.th32ProcessID;
        p->ppid        = pe.th32ParentProcessID;
        p->threadCount = pe.cntThreads;
        p->childCount  = 0;
        p->memoryUsageKB = 0;
        p->cpuTimeMs   = 0;
        p->handleCount = 0;
        strncpy(p->priority, "Unknown", sizeof(p->priority));

        /* Copy process name (convert from wide char if needed) */
        strncpy(p->name, pe.szExeFile, MAX_NAME_LEN - 1);
        p->name[MAX_NAME_LEN - 1] = '\0';

        /* Determine process status */
        get_process_status(p->pid, p->status, sizeof(p->status));

        /* Get process priority class */
        get_process_priority(p->pid, p->priority, sizeof(p->priority));

        /* Get additional details (memory usage, CPU time) */
        get_process_details(p);

        /* Add to hash table for fast lookup */
        hash_insert(p->pid, g_processCount);

        g_processCount++;
    } while (Process32Next(hSnapshot, &pe));

    CloseHandle(hSnapshot);
    return g_processCount;
}

/* ============================================================
 * Step 2: Build Tree (link children to parents)
 * Uses hash table for O(n) total complexity.
 * ============================================================ */
static void build_tree(void) {
    for (int i = 0; i < g_processCount; i++) {
        DWORD ppid = g_processes[i].ppid;
        int parentIdx = hash_lookup(ppid);

        /* Skip if parent not found (orphan) or self-referencing */
        if (parentIdx < 0 || parentIdx == i) continue;

        ProcessInfo *parent = &g_processes[parentIdx];
        if (parent->childCount < 256) {
            parent->childIndices[parent->childCount++] = i;
        }
    }
}

/* ============================================================
 * Step 3: Output JSON
 * Recursive function to print a process and its children.
 * ============================================================ */

/* Helper: escape a string for JSON output */
static void print_json_string(FILE *out, const char *str) {
    fputc('"', out);
    while (*str) {
        switch (*str) {
            case '"':  fputs("\\\"", out); break;
            case '\\': fputs("\\\\", out); break;
            case '\n': fputs("\\n",  out); break;
            case '\r': fputs("\\r",  out); break;
            case '\t': fputs("\\t",  out); break;
            default:   fputc(*str, out);   break;
        }
        str++;
    }
    fputc('"', out);
}

/* Recursive JSON printer for a process node */
static void print_process_json(FILE *out, int index, int depth) {
    ProcessInfo *p = &g_processes[index];

    /* Indentation for readability */
    for (int i = 0; i < depth; i++) fputs("  ", out);
    fputs("{\n", out);

    /* PID */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fprintf(out, "\"pid\": %lu,\n", (unsigned long)p->pid);

    /* PPID */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fprintf(out, "\"ppid\": %lu,\n", (unsigned long)p->ppid);

    /* Name */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fputs("\"name\": ", out);
    print_json_string(out, p->name);
    fputs(",\n", out);

    /* Status */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fputs("\"status\": ", out);
    print_json_string(out, p->status);
    fputs(",\n", out);

    /* Thread count */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fprintf(out, "\"threads\": %lu,\n", (unsigned long)p->threadCount);

    /* Memory usage */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fprintf(out, "\"memoryKB\": %llu,\n", (unsigned long long)p->memoryUsageKB);

    /* CPU time */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fprintf(out, "\"cpuTimeMs\": %llu,\n", (unsigned long long)p->cpuTimeMs);

    /* Priority */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fputs("\"priority\": ", out);
    print_json_string(out, p->priority);
    fputs(",\n", out);

    /* Children array */
    for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    fputs("\"children\": [", out);

    if (p->childCount > 0) {
        fputs("\n", out);
        for (int c = 0; c < p->childCount; c++) {
            print_process_json(out, p->childIndices[c], depth + 2);
            if (c < p->childCount - 1) fputs(",", out);
            fputs("\n", out);
        }
        for (int i = 0; i < depth + 1; i++) fputs("  ", out);
    }
    fputs("]\n", out);

    for (int i = 0; i < depth; i++) fputs("  ", out);
    fputs("}", out);
}

/* ============================================================
 * Main Entry Point
 * ============================================================ */
int main(int argc, char *argv[]) {
    /* Determine output destination */
    FILE *out = stdout;
    if (argc > 1) {
        out = fopen(argv[1], "w");
        if (!out) {
            fprintf(stderr, "Error: Cannot open output file '%s'\n", argv[1]);
            return 1;
        }
    }

    /* Step 1: Enumerate all running processes */
    int count = enumerate_processes();
    if (count <= 0) {
        fprintf(stderr, "Error: No processes found or enumeration failed.\n");
        if (out != stdout) fclose(out);
        return 1;
    }

    /* Step 2: Build the parent-child tree */
    build_tree();

    /* Step 3: Output as JSON
     * We output a flat array wrapped in a metadata object,
     * with root processes (orphans or System Idle Process) at the top level.
     */
    fprintf(out, "{\n");
    fprintf(out, "  \"timestamp\": %lu,\n",
            (unsigned long)GetTickCount());
    fprintf(out, "  \"totalProcesses\": %d,\n", g_processCount);
    fprintf(out, "  \"roots\": [\n");

    int rootCount = 0;
    for (int i = 0; i < g_processCount; i++) {
        /* A root process is one whose parent is not in our list,
         * or whose parent is itself (PID 0 is System Idle Process) */
        int parentIdx = hash_lookup(g_processes[i].ppid);
        if (parentIdx < 0 || parentIdx == i) {
            if (rootCount > 0) fputs(",\n", out);
            print_process_json(out, i, 2);
            rootCount++;
        }
    }

    fprintf(out, "\n  ]\n}\n");

    /* Cleanup */
    hash_free();
    if (out != stdout) fclose(out);

    return 0;
}
