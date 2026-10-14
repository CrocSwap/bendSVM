#include "solana_min.h"
#include "synthetic-generated.c"
#include "dpa1-generated.c"
#include "dcr2-generated.c"

__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 1) return 1;
  Account account;
  const u8 *next = read_account(input + 8, &account);
  if (!next || account.executable) return 2;

  if (account.size >= 4 && account.data[0] == 'D' && account.data[1] == 'P' &&
      account.data[2] == 'A' && account.data[3] == '1') {
    struct bend_external_dpa1_facts_view view;
    if (!bend_external_dpa1_facts_read(account.data, (size_t)account.size, &view)) return 3;
    u8 reply[56];
    write_le(reply, (u64)view.logical_size, 8);
    write_le(reply + 8, (u64)view.accessible_size, 8);
    write_le(reply + 16, (u64)view.window_outcomes.length, 8);
    write_le(reply + 24, (u64)view.window_outcomes.count, 8);
    write_le(reply + 32, (u64)view.window_outcomes.record_size, 8);
    write_le(reply + 40, read_le(view.window_outcomes.data, 8), 8);
    write_le(reply + 48, read_le(view.window_outcomes.data + (view.window_outcomes.count - 1) * view.window_outcomes.record_size, 8), 8);
    sol_set_return_data(reply, sizeof(reply));
  } else if (account.size >= 4 && account.data[0] == 'D' && account.data[1] == 'C' &&
             account.data[2] == 'R' && account.data[3] == '2') {
    struct bend_external_dcr2_results_view view;
    if (!bend_external_dcr2_results_read(account.data, (size_t)account.size, &view)) return 4;
    u8 reply[48];
    write_le(reply, (u64)view.logical_size, 8);
    write_le(reply + 8, (u64)view.accessible_size, 8);
    write_le(reply + 16, (u64)view.window_cells.count, 8);
    write_le(reply + 24, (u64)view.window_cells.logical_count, 8);
    write_le(reply + 32, (u64)view.window_bitmap.length, 8);
    write_le(reply + 40, view.window_bitmap.length == 0 ? 0 : view.window_bitmap.data[0], 8);
    sol_set_return_data(reply, sizeof(reply));
  } else {
    struct bend_external_synthetic_record_view view;
    if (!bend_external_synthetic_record_read(account.data, (size_t)account.size, &view)) return 5;
    u8 reply[27];
    write_le(reply, (u64)view.logical_size, 8);
    write_le(reply + 8, (u64)view.accessible_size, 8);
    write_le(reply + 16, (u64)view.window_payload.length, 8);
    reply[24] = view.window_payload.data[0];
    reply[25] = view.window_payload.data[1];
    reply[26] = view.window_payload.data[2];
    sol_set_return_data(reply, sizeof(reply));
  }
  return 0;
}
