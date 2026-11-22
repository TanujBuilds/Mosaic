#!/bin/sh
# The final call is outside this function so a truncated curl | sh cannot install.
mosaic_bootstrap() {
    unset PERL5OPT PERL5LIB PERLLIB PERLIO PERL_UNICODE PERL5DB ENV BASH_ENV CDPATH
    unset NODE_OPTIONS NODE_PATH NODE_COMPILE_CACHE TAR_OPTIONS
    exec /usr/bin/perl - "$@" <<'PERL'
use strict;
use warnings;
use Cwd qw(realpath);
use Digest::SHA qw(sha256_hex);
use Fcntl qw(:DEFAULT :flock :mode);
use File::Find ();
use File::Temp ();
use JSON::PP ();
use MIME::Base64 qw(encode_base64);

my $version = '0.1.0-beta.227';
my $stem = "mosaic-beta-$version-darwin-arm64";
my $archive_url = "https://github.com/TanujBuilds/Mosaic/releases/download/v$version/$stem.tar.gz";
my $archive_sha = 'ceec5744bf5bdd47a5404f1d7c500189abf7596cef241149aa0ee403d14fbdcc';
my $archive_bytes = 86315583;
my $manifest_sha = '7e2316cadfc1170a32eb4b67de330c8b907377c13ecc131b2fbd9ef1f461461f';
my $content_sha = 'bab071c974222fd18d9fa1901f8169042a02afb078a56b4e3840ac681ca688bd';
my $guide_revision = '398f92b2d88905cd110bf309a4984ff8a4b5ef4f';
my $guide_sha = 'e45b1e55e383d89301f9562a25b8173ffef8adee8055ff1edaee911d7c94f483';
my $helper_sha = 'e132fceb1b4b0ea25cec4796f2f65d0dc7ed7b2a3afe8541b90c458975811ec8';
my $resources = "https://raw.githubusercontent.com/TanujBuilds/Mosaic/$guide_revision/distribution/onboarding";
my $rerun = 'curl -fsSL https://raw.githubusercontent.com/TanujBuilds/Mosaic/main/install.sh | /bin/sh';
my $inspect = 'ls -ld "$HOME/.local/bin/mosaic" "$HOME/Library/Application Support/Mosaic Beta/config/installation.json" "$HOME/Library/Application Support/Mosaic Beta/config/install-transaction.json"';
my $home = $ENV{HOME} // '';
my $root = "$home/Library/Application Support/Mosaic Beta";
my $launcher = "$home/.local/bin/mosaic";
my $receipt = "$root/config/installation.json";
my ($stage, $cache_lock);
my $curl = '/usr/bin/curl';
my @curl_options = ('-q', '--fail', '--silent', '--show-error', '--location', '--globoff',
    '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5',
    '--connect-timeout', '20', '--speed-limit', '256', '--speed-time', '90');

sub fail { die "Mosaic: $_[0]\n" }
sub conflict { fail("$_[0] Existing files were preserved. Inspect them with:\n  $inspect") }
sub present { return -e $_[0] || -l $_[0] }

# Reject symlinks, special files and foreign owners before opening user files.
sub open_regular {
    my ($file, $limit) = @_;
    my @info = lstat $file;
    conflict("Unexpected file at $file.") unless @info && S_ISREG($info[2]) && $info[4] == $< && !($info[2] & 0022) && $info[7] <= $limit;
    sysopen(my $fh, $file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or conflict("Cannot read $file.");
    my @opened = stat $fh;
    conflict("File changed at $file.") unless @opened && $opened[0] == $info[0] && $opened[1] == $info[1];
    binmode $fh;
    return $fh;
}
sub read_file {
    my ($file, $limit) = @_;
    my $fh = open_regular($file, $limit);
    my $count = read($fh, my $data, $limit + 1);
    conflict("Cannot read $file.") unless defined $count && $count <= $limit;
    return $data;
}
sub digest {
    my ($file, $limit) = @_;
    return Digest::SHA->new(256)->addfile(open_regular($file, $limit))->hexdigest;
}
sub owned_directory {
    my ($dir) = @_;
    my @s = lstat $dir;
    conflict("Unexpected directory at $dir.") unless @s && S_ISDIR($s[2]) && $s[4] == $< && !($s[2] & 0022);
}
sub home_directories {
    my ($relative, $create) = @_;
    my $dir = $home;
    for my $part (split m{/}, $relative) {
        $dir .= "/$part";
        if (!present($dir)) {
            return unless $create;
            mkdir($dir, 0700) or -d $dir or fail("Cannot create $dir.");
        }
        owned_directory($dir);
    }
    return $dir;
}
sub shell_quote {
    my ($value) = @_;
    $value =~ s/'/'"'"'/g;
    return "'$value'";
}
sub version_tuple {
    my ($v) = @_;
    my @parts = $v =~ /\A(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-beta\.(0|[1-9][0-9]{0,8}))?\z/;
    conflict("The installation receipt has an unfamiliar version.") unless @parts;
    return (@parts[0..2], defined($parts[3]) ? 0 : 1, $parts[3] // 0);
}
sub release_order {
    my @installed = version_tuple($_[0]);
    my @target = version_tuple($version);
    for my $i (0..$#target) { return $installed[$i] <=> $target[$i] if $installed[$i] != $target[$i]; }
    return 0;
}

# For this exact release, the independent manifest digest binds every installed
# file, including the interpreter. Check the tree before executing its launcher.
sub verify_current {
    my ($directory, $manifest_data, $manifest) = @_;
    conflict("The installed beta manifest differs from the published release.") unless sha256_hex($manifest_data) eq $manifest_sha;
    my %files = map { $_->{path} => $_ } @{$manifest->{files}};
    File::Find::find({ no_chdir => 1, wanted => sub {
        my $name = $File::Find::name;
        return if $name eq $directory;
        my $relative = substr($name, length($directory) + 1);
        my @s = lstat $name;
        if (S_ISDIR($s[2])) { owned_directory($name); return; }
        return if $relative eq 'package-manifest.json';
        my $entry = delete $files{$relative};
        conflict("The installed runtime contains a changed file at $relative.") unless $entry
            && S_ISREG($s[2]) && ($s[2] & 07777) == (oct($entry->{mode}) & 07777)
            && $s[7] == $entry->{bytes} && digest($name, $entry->{bytes}) eq $entry->{sha256};
    }}, $directory);
    conflict("Files from the installed runtime are missing.") if keys %files;
}
sub managed_launchers {
    my ($v) = @_;
    my $runtime = "$root/versions/$v/runtime";
    my $bin = shell_quote("$runtime/bin");
    my $local_bin = shell_quote("$home/.local/bin");
    my $exec = 'exec '.shell_quote("$runtime/bin/node").' '.shell_quote("$runtime/src/beta/cli.mjs").' "$@"';
    return map { "#!/bin/sh\n# Mosaic Beta managed launcher v1\nPATH=$bin:$local_bin".$_.
        ':"$PATH"'."\nexport PATH\n$exec\n" } ('', ':/opt/homebrew/bin:/usr/local/bin');
}

# During a legitimate package transaction the on-disk launcher and receipt can
# intentionally disagree. Inspect the target first. The original installer
# checks the real pointers, transaction, prior inventory and lock before writing.
sub pending_release {
    my ($file) = @_;
    my $tx = eval { JSON::PP->new->utf8->decode(read_file($file, 65536)) };
    my $new = ref($tx) eq 'HASH' ? $tx->{newReceipt} : undef;
    my ($expected) = managed_launchers($version);
    my $invalid = 'The pending installation transaction has an unfamiliar owner or target.';
    conflict($invalid) unless ref($new) eq 'HASH' && !((stat $file)[2] & 0077)
        && ($tx->{schema} // '') eq '1' && ($tx->{version} // '') eq $version
        && ($tx->{phase} // '') =~ /\A(?:stopping|prepared|staged|launcher|receipt|committed|restored)\z/
        && ($new->{version} // '') eq $version && ($new->{contentHash} // '') eq $content_sha
        && ($new->{launcherHash} // '') eq sha256_hex($expected);
    my $old = $tx->{oldReceipt};
    if (defined $old || defined $tx->{oldLauncher}) {
        conflict($invalid) unless ref($old) eq 'HASH' && defined $tx->{oldLauncher};
        my $v = $old->{version} // '';
        conflict("A newer release owns the prior installation.") if release_order($v) > 0;
        conflict($invalid) unless grep {
            encode_base64($_, '') eq $tx->{oldLauncher} && sha256_hex($_) eq ($old->{launcherHash} // '')
        } managed_launchers($v);
    }
    return 'recovering';
}
sub install_state {
    home_directories('.local/bin', 0);
    home_directories('Library/Application Support/Mosaic Beta/config', 0);
    my $transaction = "$root/config/install-transaction.json";
    return pending_release($transaction) if present($transaction);
    if (!present($launcher) && !present($receipt)) {
        conflict("An incomplete Mosaic installation needs inspection.") if present("$root/config/settings.json");
        return 'fresh';
    }
    conflict("The Mosaic launcher or its installation receipt is missing.") unless present($launcher) && present($receipt);
    my $r = eval { JSON::PP->new->utf8->decode(read_file($receipt, 8192)) };
    conflict("The Mosaic installation receipt is unreadable.") unless ref($r) eq 'HASH' && ($r->{schema} // '') eq '1'
        && ($r->{contentHash} // '') =~ /\A[a-f0-9]{64}\z/ && ($r->{launcherHash} // '') =~ /\A[a-f0-9]{64}\z/
        && !( (stat $receipt)[2] & 0077 );
    my $v = $r->{version} // '';
    my $order = release_order($v);
    my $directory = home_directories("Library/Application Support/Mosaic Beta/versions/$v", 0);
    conflict("The installed Mosaic runtime is missing.") unless defined $directory;
    my $bytes = read_file($launcher, 16384);
    my @expected = managed_launchers($v);
    conflict("The existing Mosaic launcher is foreign or modified.") unless -x $launcher
        && sha256_hex($bytes) eq $r->{launcherHash} && grep { $_ eq $bytes } @expected;
    my $data = read_file("$directory/package-manifest.json", 8 * 1024 * 1024);
    my $manifest = eval { JSON::PP->new->utf8->decode($data) };
    conflict("The installed manifest and receipt disagree.") unless ref($manifest) eq 'HASH'
        && ($manifest->{version} // '') eq $v && ($manifest->{contentHash} // '') eq $r->{contentHash};
    verify_current($directory, $data, $manifest) if $order == 0;
    if ($order > 0) { print "Mosaic $v is newer than $version. Continue with your installed version:\n".'  "$HOME/.local/bin/mosaic" setup'."\n"; return 'newer'; }
    return $order < 0 ? 'older' : 'current';
}

sub download_resource {
    my ($name, $expected) = @_;
    my $file = "$stage/$name";
    system($curl, @curl_options, '--max-filesize', '1048576', '--max-time', '150',
        '--retry', '3', '--retry-all-errors', '--output', $file, '--url', "$resources/$name") == 0
        or fail("Could not download $name. Retry with:\n  $rerun");
    digest($file, 1048576) eq $expected or fail("Checksum failed for $name. Retry with:\n  $rerun");
}

sub archive_download {
    my $cache = home_directories('Library/Caches/Mosaic Beta Installer', 1);
    my @s = stat $cache;
    fail("Mosaic download cache must be private (0700): $cache") if $s[2] & 0077;
    open($cache_lock, '<', $cache) or fail("Cannot open $cache.");
    flock($cache_lock, LOCK_EX | LOCK_NB) or fail("Another Mosaic install is in progress. Wait for it, then retry.");
    my $file = "$cache/$stem.tar.gz.part";
    if (present($file)) {
        my @part = lstat $file;
        fail("Unexpected download cache entry at $file.") unless S_ISREG($part[2]) && $part[3] == 1 && $part[4] == $< && !($part[2] & 0077) && $part[7] <= $archive_bytes;
    }
    sysopen(my $out, $file, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600) or fail("Cannot open the download cache.");
    binmode $out;
    my $offset = sysseek($out, 0, 2);
    defined $offset or fail("Cannot read the download cache.");
    $offset = 0 + $offset;
    print "Downloading Mosaic Beta $version".($offset ? " (resuming at $offset bytes)" : '')."…\n";
    while ($offset < $archive_bytes) {
        my $end = $offset + 4 * 1024 * 1024 - 1;
        $end = $archive_bytes - 1 if $end >= $archive_bytes;
        my $part = "$stage/chunk";
        my $headers = "$stage/headers";
        my $received = 0;
        for my $attempt (1..4) {
            unlink $part, $headers;
            my $status = system($curl, @curl_options, '--range', "$offset-$end", '--max-filesize', "$archive_bytes",
                '--max-time', '600', '--dump-header', $headers, '--output', $part, '--url', $archive_url);
            if ($status != -1 && ($status & 127)) {
                print STDERR "Mosaic: Download interrupted. Resume with:\n  $rerun\n";
                exit child_status($status);
            }
            if ($status == 0) {
                my $raw = read_file($headers, 131072);
                my @responses = grep { /\AHTTP\/\S+ \d{3}/ } split /\r?\n\r?\n/, $raw;
                my $response = $responses[-1] // '';
                # A server that ignores Range may return the complete archive.
                if ($response =~ /\AHTTP\/\S+ 200\b/ && -s $part == $archive_bytes) {
                    truncate($out, 0) && defined(sysseek($out, 0, 0)) or fail("Cannot replace the download cache.");
                    $offset = 0; $received = $archive_bytes;
                } elsif ($response =~ /\AHTTP\/\S+ 206\b/
                    && $response =~ /^Content-Range:\s*bytes \Q$offset-$end\/$archive_bytes\E\s*$/mi && -s $part == $end - $offset + 1) {
                    $received = $end - $offset + 1;
                }
                last if $received;
            }
            if ($attempt < 4) { print STDERR "Mosaic: Retrying download at byte $offset…\n"; sleep $attempt; }
        }
        fail("Download interrupted. Resume with:\n  $rerun") unless $received;
        my $chunk = open_regular($part, $received);
        while (1) {
            my $n = sysread($chunk, my $buf, 65536);
            fail("Cannot read downloaded data.") unless defined $n;
            last unless $n;
            my $written = syswrite($out, $buf);
            fail("Cannot save downloaded data. Check available disk space.") unless defined $written && $written == $n;
        }
        $offset += $received;
        printf "  %d%%\n", 100 * $offset / $archive_bytes;
    }
    close($out) or fail("Could not save the complete download.");
    unless (-s $file == $archive_bytes && digest($file, $archive_bytes) eq $archive_sha) {
        unlink($file) or fail("Checksum failed. Remove the invalid cache file at $file before retrying.");
        fail("Archive checksum failed. Download a fresh copy with:\n  $rerun");
    }
    return $file;
}
sub child_status {
    my ($status) = @_;
    return 1 if $status == -1;
    return ($status & 127) ? 128 + ($status & 127) : $status >> 8;
}
sub run {
    fail('Run this installer without arguments.') if @ARGV;
    fail('Use Terminal on an Apple Silicon Mac running natively.') unless
        `/usr/bin/uname -s` eq "Darwin\n" && `/usr/bin/uname -m` eq "arm64\n";
    {
        local $ENV{SYSTEM_VERSION_COMPAT} = '0';
        my $product = `/usr/bin/sw_vers -productVersion`;
        fail('This release requires macOS 26 or newer on Apple Silicon. Check About This Mac.') unless
            $? == 0 && $product =~ /\A([1-9][0-9]{0,2})(?:\.[0-9]+){0,2}\n?\z/ && $1 >= 26;
    }
    fail('Run this installer as your own Mac user, without sudo.') if $< == 0;
    fail('Open Terminal and paste the installation command there.') unless -t STDOUT
        && open(STDIN, '<', '/dev/tty') && -t STDIN;
    fail('Your home directory is unavailable.') unless $home =~ m{\A/[^\x00-\x1f\x7f]+\z} && $home !~ m{(?:/\.{1,2}(?:/|\z)|//|/\z)} && -d $home && -o $home;
    my $login_home = (getpwuid($<))[7];
    fail('HOME must point to the home directory of the current Mac login user.') unless defined $login_home
        && defined realpath($login_home) && realpath($home) eq realpath($login_home);
    owned_directory(realpath($home));
    $| = 1;
    umask 0077;
    my $state = install_state();
    return 0 if $state eq 'newer';
    $stage = File::Temp->newdir('mosaic-install-XXXXXXXX', DIR => '/private/tmp');
    download_resource('guide.sh', $guide_sha);
    download_resource('host.mjs', $helper_sha);
    if ($state ne 'current') {
        my $archive = archive_download();
        # A user may have finished updating Mosaic during a slow download.
        $state = install_state();
        return 0 if $state eq 'newer';
        if ($state ne 'current') {
            print "Verified Mosaic Beta $version. ".($state eq 'recovering' ? 'Resuming interrupted installation…' : 'Installing…')."\n";
            system('/usr/bin/tar', '-xzpf', $archive, '--no-same-owner', '-C', "$stage") == 0 or fail('The verified archive could not be unpacked.');
            # Keep files if this parent is interrupted while the package is running.
            $stage->unlink_on_destroy(0);
            my $installer = "$stage/$stem/install";
            my $status = system { $installer } $installer;
            $stage->unlink_on_destroy(1);
            fail("The package installer could not finish. Review its message above, then retry with:\n  $rerun") if child_status($status);
            $state = install_state();
            return 0 if $state eq 'newer';
            fail('The package installer returned without activating the expected version.') unless $state eq 'current';
        }
        unlink $archive or warn "Mosaic: Could not clear the verified download cache.\n";
    } else {
        print "Mosaic Beta $version is already installed. Continuing setup…\n";
    }
    undef $cache_lock;
    my $result = child_status(system('/bin/sh', "$stage/guide.sh"));
    print STDERR "Resume the guided setup with:\n  $rerun\n" if $result;
    return $result;
}
exit run();
PERL
}
mosaic_bootstrap "$@"
