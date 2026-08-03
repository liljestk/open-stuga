#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_DSYNC
#define O_DSYNC 0
#endif

enum {
    RECORD_SIZE = 4096,
    HEADER_SIZE = 24,
    CRC_OFFSET = RECORD_SIZE - 4,
};

static const off_t RECORD_OFFSETS[2] = {
    (off_t)95 * 1024 * 1024,
    (off_t)95 * 1024 * 1024 + RECORD_SIZE,
};
static const unsigned char MAGIC[8] = {'S', 'T', 'U', 'G', 'U', 'B', 'C', '1'};

typedef struct {
    unsigned char raw[RECORD_SIZE];
    uint64_t sequence;
    uint32_t payload_size;
    size_t tries_position[2];
    unsigned int tries[2];
    char committed;
    char pending;
    char fallback;
    char state[16];
    int index;
    bool valid;
    bool zero;
} boot_record;

static uint16_t read_le16(const unsigned char *value) {
    return (uint16_t)value[0] | ((uint16_t)value[1] << 8);
}

static uint32_t read_le32(const unsigned char *value) {
    return (uint32_t)value[0] | ((uint32_t)value[1] << 8) |
           ((uint32_t)value[2] << 16) | ((uint32_t)value[3] << 24);
}

static uint64_t read_le64(const unsigned char *value) {
    return (uint64_t)read_le32(value) | ((uint64_t)read_le32(value + 4) << 32);
}

static void write_le32(unsigned char *target, uint32_t value) {
    target[0] = (unsigned char)(value & 0xffu);
    target[1] = (unsigned char)((value >> 8) & 0xffu);
    target[2] = (unsigned char)((value >> 16) & 0xffu);
    target[3] = (unsigned char)((value >> 24) & 0xffu);
}

static void write_le64(unsigned char *target, uint64_t value) {
    write_le32(target, (uint32_t)(value & UINT32_MAX));
    write_le32(target + 4, (uint32_t)(value >> 32));
}

static uint32_t crc32_bytes(const unsigned char *data, size_t size) {
    uint32_t crc = UINT32_MAX;
    for (size_t index = 0; index < size; ++index) {
        crc ^= data[index];
        for (unsigned int bit = 0; bit < 8; ++bit) {
            uint32_t mask = (uint32_t)-(int32_t)(crc & 1u);
            crc = (crc >> 1) ^ (0xedb88320u & mask);
        }
    }
    return ~crc;
}

static bool all_bytes_are(const unsigned char *data, size_t size, unsigned char value) {
    for (size_t index = 0; index < size; ++index) {
        if (data[index] != value) return false;
    }
    return true;
}

static const unsigned char *find_once(
    const unsigned char *data,
    size_t size,
    const char *needle,
    size_t *position
) {
    const size_t needle_size = strlen(needle);
    const unsigned char *match = NULL;
    if (needle_size == 0 || size < needle_size) return NULL;
    for (size_t index = 0; index <= size - needle_size; ++index) {
        if (memcmp(data + index, needle, needle_size) != 0) continue;
        if (match != NULL) return NULL;
        match = data + index;
        if (position != NULL) *position = index;
    }
    return match;
}

static bool parse_slot_field(
    const unsigned char *payload,
    size_t size,
    const char *name,
    bool nullable,
    char *result
) {
    char needle[48];
    int written = snprintf(needle, sizeof(needle), "\"%s\":", name);
    if (written <= 0 || (size_t)written >= sizeof(needle)) return false;
    size_t position = 0;
    if (find_once(payload, size, needle, &position) == NULL) return false;
    position += (size_t)written;
    if (nullable && position + 4 <= size &&
        memcmp(payload + position, "null", 4) == 0) {
        *result = '\0';
        return true;
    }
    if (position + 3 > size || payload[position] != '"' ||
        payload[position + 2] != '"' ||
        (payload[position + 1] != 'a' && payload[position + 1] != 'b')) {
        return false;
    }
    *result = (char)payload[position + 1];
    return true;
}

static bool parse_state(
    const unsigned char *payload,
    size_t size,
    char result[16]
) {
    const char *needle = "\"state\":\"";
    size_t position = 0;
    if (find_once(payload, size, needle, &position) == NULL) return false;
    position += strlen(needle);
    size_t end = position;
    while (end < size && payload[end] != '"' && end - position < 15) ++end;
    if (end == position || end >= size || payload[end] != '"') return false;
    memcpy(result, payload + position, end - position);
    result[end - position] = '\0';
    return strcmp(result, "successful") == 0 || strcmp(result, "pending") == 0 ||
           strcmp(result, "probation") == 0 || strcmp(result, "fallback") == 0 ||
           strcmp(result, "rescue") == 0;
}

static bool parse_tries(
    const unsigned char *payload,
    size_t size,
    char slot,
    size_t *digit_position,
    unsigned int *value
) {
    const char *slot_a = "\"slots\":{\"a\":{";
    const char *slot_b = "},\"b\":{";
    const char *slots_end = "}},\"state\":";
    size_t a_position = 0;
    size_t b_position = 0;
    size_t end_position = 0;
    if (find_once(payload, size, slot_a, &a_position) == NULL ||
        find_once(payload, size, slot_b, &b_position) == NULL ||
        find_once(payload, size, slots_end, &end_position) == NULL ||
        !(a_position < b_position && b_position < end_position)) {
        return false;
    }
    size_t start = slot == 'a' ? a_position + strlen(slot_a) : b_position + strlen(slot_b);
    size_t end = slot == 'a' ? b_position : end_position;
    const char *needle = "\"triesRemaining\":";
    size_t relative = 0;
    if (find_once(payload + start, end - start, needle, &relative) == NULL) return false;
    size_t digit = start + relative + strlen(needle);
    if (digit >= end || payload[digit] < '0' || payload[digit] > '7') return false;
    if (digit + 1 >= size || payload[digit + 1] != '}') return false;
    *digit_position = digit;
    *value = (unsigned int)(payload[digit] - '0');
    return true;
}

static bool decode_record(boot_record *record, int index) {
    record->index = index;
    record->zero = all_bytes_are(record->raw, RECORD_SIZE, 0);
    if (record->zero) return false;
    if (memcmp(record->raw, MAGIC, sizeof(MAGIC)) != 0 ||
        read_le16(record->raw + 8) != 1 ||
        read_le16(record->raw + 10) != HEADER_SIZE) {
        return false;
    }
    const uint32_t payload_size = read_le32(record->raw + 20);
    if (payload_size == 0 || payload_size > CRC_OFFSET - HEADER_SIZE) return false;
    if (crc32_bytes(record->raw, CRC_OFFSET) != read_le32(record->raw + CRC_OFFSET)) {
        return false;
    }
    if (!all_bytes_are(
            record->raw + HEADER_SIZE + payload_size,
            CRC_OFFSET - HEADER_SIZE - payload_size,
            0
        )) {
        return false;
    }
    unsigned char *payload = record->raw + HEADER_SIZE;
    for (uint32_t index_in_payload = 0; index_in_payload < payload_size; ++index_in_payload) {
        if (payload[index_in_payload] < 0x20 || payload[index_in_payload] > 0x7e) return false;
    }
    if (payload[0] != '{' || payload[payload_size - 1] != '}' ||
        find_once(
            payload,
            payload_size,
            "\"schema\":\"stugu-boot-control/v1\"",
            NULL
        ) == NULL ||
        !parse_slot_field(payload, payload_size, "committed", false, &record->committed) ||
        !parse_slot_field(payload, payload_size, "pending", true, &record->pending) ||
        !parse_slot_field(payload, payload_size, "fallback", true, &record->fallback) ||
        !parse_state(payload, payload_size, record->state) ||
        !parse_tries(
            payload,
            payload_size,
            'a',
            &record->tries_position[0],
            &record->tries[0]
        ) ||
        !parse_tries(
            payload,
            payload_size,
            'b',
            &record->tries_position[1],
            &record->tries[1]
        )) {
        return false;
    }
    record->sequence = read_le64(record->raw + 12);
    record->payload_size = payload_size;
    record->valid = true;
    return true;
}

static bool records_match(const boot_record *left, const boot_record *right) {
    return left->sequence == right->sequence &&
           left->payload_size == right->payload_size &&
           memcmp(
               left->raw + HEADER_SIZE,
               right->raw + HEADER_SIZE,
               left->payload_size
           ) == 0;
}

static bool full_pread(int descriptor, unsigned char *data, size_t size, off_t offset) {
    size_t complete = 0;
    while (complete < size) {
        ssize_t received = pread(descriptor, data + complete, size - complete, offset + (off_t)complete);
        if (received == 0) return false;
        if (received < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        complete += (size_t)received;
    }
    return true;
}

static bool full_pwrite(int descriptor, const unsigned char *data, size_t size, off_t offset) {
    size_t complete = 0;
    while (complete < size) {
        ssize_t written = pwrite(descriptor, data + complete, size - complete, offset + (off_t)complete);
        if (written <= 0) {
            if (written < 0 && errno == EINTR) continue;
            return false;
        }
        complete += (size_t)written;
    }
    return true;
}

static bool persist_decrement(int descriptor, boot_record *record, char slot) {
    if (record->sequence == UINT64_MAX) return false;
    const int slot_index = slot == 'a' ? 0 : 1;
    if (record->tries[slot_index] == 0) return false;
    record->tries[slot_index] -= 1;
    record->raw[HEADER_SIZE + record->tries_position[slot_index]] =
        (unsigned char)('0' + record->tries[slot_index]);
    record->sequence += 1;
    write_le64(record->raw + 12, record->sequence);
    write_le32(record->raw + CRC_OFFSET, crc32_bytes(record->raw, CRC_OFFSET));
    const int target_index = 1 - record->index;
    if (!full_pwrite(descriptor, record->raw, RECORD_SIZE, RECORD_OFFSETS[target_index]) ||
        fsync(descriptor) != 0) {
        return false;
    }
    unsigned char verified[RECORD_SIZE];
    if (!full_pread(descriptor, verified, sizeof(verified), RECORD_OFFSETS[target_index]) ||
        memcmp(verified, record->raw, sizeof(verified)) != 0) {
        return false;
    }
    record->index = target_index;
    return true;
}

static int select_slot(int descriptor, boot_record records[2], char *selected) {
    boot_record *current = NULL;
    if (records[0].valid && records[1].valid) {
        if (records[0].sequence == records[1].sequence &&
            !records_match(&records[0], &records[1])) {
            fprintf(stderr, "Stugu: boot-control records conflict\n");
            return 1;
        }
        current = records[0].sequence >= records[1].sequence ? &records[0] : &records[1];
    } else if (records[0].valid) {
        current = &records[0];
    } else if (records[1].valid) {
        current = &records[1];
    } else if (records[0].zero && records[1].zero) {
        *selected = 'a';
        return 0;
    } else {
        fprintf(stderr, "Stugu: boot-control records are invalid\n");
        return 1;
    }

    if (strcmp(current->state, "pending") == 0) {
        if ((current->pending != 'a' && current->pending != 'b') ||
            (current->fallback != 'a' && current->fallback != 'b')) {
            return 1;
        }
        const int pending_index = current->pending == 'a' ? 0 : 1;
        if (current->tries[pending_index] == 0) {
            *selected = current->fallback;
            return 0;
        }
        if (!persist_decrement(descriptor, current, current->pending)) {
            fprintf(stderr, "Stugu: could not account for pending boot attempt\n");
            return 1;
        }
        *selected = current->pending;
        return 0;
    }

    if (strcmp(current->state, "probation") == 0) {
        if ((current->committed != 'a' && current->committed != 'b') ||
            (current->fallback != 'a' && current->fallback != 'b')) {
            return 1;
        }
        const int committed_index = current->committed == 'a' ? 0 : 1;
        if (current->tries[committed_index] == 0) {
            *selected = current->fallback;
            return 0;
        }
        if (!persist_decrement(descriptor, current, current->committed)) {
            fprintf(stderr, "Stugu: could not account for probation boot attempt\n");
            return 1;
        }
        *selected = current->committed;
        return 0;
    }

    if (current->committed != 'a' && current->committed != 'b') return 1;
    *selected = current->committed;
    return 0;
}

int main(int argc, char **argv) {
    bool permit_regular = false;
    const char *path = NULL;
    if (argc == 2) {
        path = argv[1];
    } else if (argc == 3 && strcmp(argv[1], "--test-file") == 0) {
        permit_regular = true;
        path = argv[2];
    } else {
        fprintf(stderr, "usage: stugu-boot-select [--test-file] DEVICE\n");
        return 2;
    }

    int flags = O_RDWR | O_CLOEXEC | O_DSYNC;
    int descriptor = open(path, flags);
    if (descriptor < 0) {
        fprintf(stderr, "Stugu: cannot open boot-control device: %s\n", strerror(errno));
        return 2;
    }
    struct stat status;
    if (fstat(descriptor, &status) != 0 ||
        (!S_ISBLK(status.st_mode) && !(permit_regular && S_ISREG(status.st_mode)))) {
        fprintf(stderr, "Stugu: boot-control target is not an approved device\n");
        close(descriptor);
        return 2;
    }

    boot_record records[2] = {0};
    for (int index = 0; index < 2; ++index) {
        if (!full_pread(
                descriptor,
                records[index].raw,
                RECORD_SIZE,
                RECORD_OFFSETS[index]
            )) {
            fprintf(stderr, "Stugu: cannot read boot-control record\n");
            close(descriptor);
            return 2;
        }
        (void)decode_record(&records[index], index);
    }

    char selected = '\0';
    int result = select_slot(descriptor, records, &selected);
    if (close(descriptor) != 0 && result == 0) result = 2;
    if (result != 0 || (selected != 'a' && selected != 'b')) return result != 0 ? result : 2;
    printf("%c\n", selected);
    return fflush(stdout) == 0 ? 0 : 2;
}
