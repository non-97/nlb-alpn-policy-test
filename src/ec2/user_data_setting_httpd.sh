# -x to display the command to be executed
set -x

# Redirect /var/log/user-data.log and /dev/console
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

# Install the necessary packages
yum update -y
yum install -y httpd

echo "test text" > /var/www/html/index.html

# Start Nginx
systemctl start httpd
systemctl status httpd

# Enable Nginx
systemctl enable httpd
systemctl is-enabled httpd