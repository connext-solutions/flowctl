---
id: leave-submit
title: Gửi đơn nghỉ
actor: employee
---

# Đơn từ

## Gửi đơn nghỉ

Nhân viên gửi một đơn nghỉ từ màn Đơn từ.

### Các bước

1. Mở màn Đơn từ.
2. Nhập "Lý do", "Số tiền" và chọn "Nhân viên".
3. Bấm "Gửi".

### Kết quả mong đợi

Khi gửi thành công:

- Màn hình hiện thông báo "Đã gửi đơn".
- Hệ thống trả về mã 201 cho yêu cầu tạo đơn.
- Địa chỉ trang đổi thành "/requests?saved=1".
- Ô "Lý do" được xoá trống sau khi gửi.
- Đơn gửi đi có loại "LEAVE" và đúng số tiền đã nhập.

Khi máy chủ báo lỗi:

- Màn hình hiện thông báo "Gửi đơn thất bại" và không hiện "Đã gửi đơn".
