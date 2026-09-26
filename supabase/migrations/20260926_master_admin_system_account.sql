-- Master Admin is a system-control account, not an employee: account_type='system'
-- keeps it out of the employee roster, attendance, time tracking, leave and payroll.
update hr_employees set account_type = 'system'
 where lower(portal_email) = 'admin@brokenenglish.com' and full_name = 'Master Admin';
