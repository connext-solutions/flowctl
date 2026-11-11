---
id: leave-approve
title: Quản lý duyệt đơn nghỉ
actor: manager
---

# Phê duyệt

## Quản lý duyệt đơn nghỉ

Quản lý mở màn Phê duyệt và bấm "Duyệt" ở đơn của nhân viên.

### Kết quả mong đợi

- Màn hình hiện thông báo "Đã duyệt đơn".
- Hệ thống trả về mã 200 cho yêu cầu duyệt.
- Đơn được duyệt hiện trạng thái "Đã duyệt".
- Trang không ghi lỗi nào vào console.

### Phân quyền

- Nhân viên không duyệt được đơn: máy chủ trả về mã 403.
